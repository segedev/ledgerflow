import express from "express";
import { randomUUID } from "node:crypto";
import { AppError, fail } from "./errors.js";
import {
  identifier,
  key,
  money,
  object,
  validateTransfer,
  CURRENCIES,
} from "./validation.js";
import { secureEqual, verifyWebhook } from "./security.js";
import { postTransfer } from "./ledger.js";
import { reconcile } from "./reconciliation.js";
import { detectAnomaly } from "./anomaly.js";

export function createApp({
  client,
  db,
  apiKey,
  webhookSecret,
  rateLimit = 1000,
  logger = console,
}) {
  if (
    typeof apiKey !== "string" ||
    apiKey.length < 32 ||
    typeof webhookSecret !== "string" ||
    webhookSecret.length < 32 ||
    apiKey === webhookSecret
  )
    throw new Error(
      "Distinct API and webhook secrets of at least 32 characters are required.",
    );
  const app = express();
  app.disable("x-powered-by");
  app.set("trust proxy", false);
  // Process-local circuit breaker. Put a distributed limiter at the ingress in production.
  let windowStart = Date.now(),
    requests = 0;
  app.use((req, res, next) => {
    req.requestId = randomUUID();
    res.set({
      "X-Request-Id": req.requestId,
      "X-Content-Type-Options": "nosniff",
      "Cache-Control": "no-store",
      "Content-Security-Policy": "default-src 'none'; frame-ancestors 'none'",
    });
    if (req.path.startsWith("/health/")) return next();
    if (Date.now() - windowStart >= 60000) {
      windowStart = Date.now();
      requests = 0;
    }
    if (++requests > rateLimit) {
      res.set("Retry-After", "60");
      return next(
        new AppError(
          429,
          "RATE_LIMIT",
          "Request limit reached. Retry later with the same idempotency key.",
        ),
      );
    }
    next();
  });
  app.get("/health/live", (_req, res) => res.json({ status: "ok" }));
  app.get("/health/ready", async (_req, res) => {
    try {
      const hello = await client
        .db("admin")
        .command({ hello: 1 }, { timeoutMS: 2000 });
      if (!hello.isWritablePrimary && hello.msg !== "isdbgrid")
        return res.status(503).json({ status: "unavailable" });
      res.json({ status: "ready" });
    } catch {
      res.status(503).json({ status: "unavailable" });
    }
  });
  const requireJson = (req, _res, next) =>
    req.is("application/json")
      ? next()
      : next(
          new AppError(
            415,
            "UNSUPPORTED_MEDIA_TYPE",
            "Content-Type must be application/json.",
          ),
        );
  app.post(
    "/v1/webhooks/transfers",
    requireJson,
    express.raw({ type: "application/json", limit: "16kb", inflate: false }),
    async (req, res) => {
      verifyWebhook({
        raw: req.body,
        timestamp: req.get("X-Webhook-Timestamp"),
        signature: req.get("X-Webhook-Signature"),
        secret: webhookSecret,
      });
      let body;
      try {
        body = JSON.parse(req.body.toString("utf8"));
      } catch {
        fail(400, "INVALID_JSON", "Invalid JSON body.");
      }
      object(body, ["eventId", "idempotencyKey", "transfer"]);
      const eventId = identifier(body.eventId, "eventId");
      const idempotencyKey = key(body.idempotencyKey);
      const transfer = validateTransfer(body.transfer);
      const posted = await postTransfer({
        client,
        db,
        transfer,
        idempotencyKey,
        eventId,
        allowClearing: true,
      });
      res.json({ ...posted.result, replayed: posted.replayed });
    },
  );
  // Every other /v1 endpoint is a single-tenant administrator endpoint.
  app.use("/v1", (req, _res, next) => {
    if (!secureEqual(req.get("Authorization"), `Bearer ${apiKey}`))
      return next(
        new AppError(
          401,
          "UNAUTHORIZED",
          "A valid Bearer API key is required.",
        ),
      );
    next();
  });
  app.use("/v1", express.json({ limit: "16kb", inflate: false }));
  app.post("/v1/accounts", requireJson, async (req, res) => {
    object(req.body, ["id", "currency"]);
    const id = identifier(req.body.id);
    if (id.startsWith("clearing_"))
      fail(400, "RESERVED_ACCOUNT", "The clearing_ prefix is reserved.");
    if (!CURRENCIES.includes(req.body.currency))
      fail(
        400,
        "INVALID_CURRENCY",
        `currency must be one of ${CURRENCIES.join(", ")}.`,
      );
    const account = {
      _id: id,
      currency: req.body.currency,
      kind: "wallet",
      balance: 0,
      createdAt: new Date(),
    };
    try {
      await db
        .collection("accounts")
        .insertOne(account, { writeConcern: { w: "majority", j: true } });
    } catch (e) {
      if (e.code === 11000)
        fail(409, "ACCOUNT_EXISTS", "Account ID already exists.");
      throw e;
    }
    res.status(201).json({ id, ...account, _id: undefined });
  });
  app.get("/v1/accounts/:id", async (req, res) => {
    const account = await db
      .collection("accounts")
      .findOne({ _id: identifier(req.params.id) });
    if (!account) fail(404, "ACCOUNT_NOT_FOUND", "Account does not exist.");
    res.json({ id: account._id, ...account, _id: undefined });
  });
  app.post("/v1/transfers", requireJson, async (req, res) => {
    const transfer = validateTransfer(req.body);
    const posted = await postTransfer({
      client,
      db,
      transfer,
      idempotencyKey: key(req.get("Idempotency-Key")),
    });
    res
      .status(posted.replayed ? 200 : 201)
      .json({ ...posted.result, replayed: posted.replayed });
  });
  app.get("/v1/transfers/:id", async (req, res) => {
    const transfer = await db
      .collection("transfers")
      .findOne({ _id: identifier(req.params.id) });
    if (!transfer) fail(404, "TRANSFER_NOT_FOUND", "Transfer does not exist.");
    res.json({ transferId: transfer._id, ...transfer, _id: undefined });
  });
  app.get("/v1/reconciliation", async (_req, res) =>
    res.json(await reconcile({ client, db })),
  );
  app.post("/v1/anomalies/score", requireJson, async (req, res) => {
    object(req.body, ["accountId", "currency", "amount"]);
    const accountId = identifier(req.body.accountId, "accountId");
    money(req.body.amount, req.body.currency);
    const account = await db.collection("accounts").findOne({ _id: accountId });
    if (!account) fail(404, "ACCOUNT_NOT_FOUND", "Account does not exist.");
    if (account.currency !== req.body.currency)
      fail(422, "CURRENCY_MISMATCH", "Account currency does not match.");
    const history = await db
      .collection("transfers")
      .find(
        { fromAccountId: accountId, currency: req.body.currency },
        { projection: { amount: 1 }, maxTimeMS: 5000 },
      )
      .sort({ createdAt: -1, _id: -1 })
      .limit(2000)
      .toArray();
    res.json(detectAnomaly(history, req.body.amount));
  });
  app.use((_req, _res, next) =>
    next(new AppError(404, "NOT_FOUND", "Endpoint does not exist.")),
  );
  app.use((error, req, res, _next) => {
    let status = error instanceof AppError ? error.status : 500;
    let code = error instanceof AppError ? error.code : "INTERNAL_ERROR";
    let message =
      error instanceof AppError
        ? error.message
        : "Request failed. Retry safely with the same idempotency key.";
    if (error.type === "entity.parse.failed") {
      status = 400;
      code = "INVALID_JSON";
      message = "Invalid JSON body.";
    }
    if (error.type === "entity.too.large") {
      status = 413;
      code = "BODY_TOO_LARGE";
      message = "Body must not exceed 16 KiB.";
    }
    if (
      error.type === "encoding.unsupported" ||
      error.type === "charset.unsupported"
    ) {
      status = 415;
      code = "UNSUPPORTED_ENCODING";
      message = "Use uncompressed UTF-8 JSON.";
    }
    if (error.code === 11000 || error.name?.startsWith("Mongo")) {
      status = 503;
      code = "DATABASE_UNAVAILABLE";
      message =
        "Database operation could not be confirmed. Retry with the same idempotency key.";
    }
    if (status >= 500)
      logger.error({ requestId: req.requestId, code, errorName: error.name });
    res
      .status(status)
      .json({ error: { code, message, requestId: req.requestId } });
  });
  return app;
}

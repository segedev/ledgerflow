import test from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import request from "supertest";
import { createApp } from "../src/app.js";
const apiKey = "admin-key-".repeat(5),
  webhookSecret = "webhook-key-".repeat(5);
// These tests cover the HTTP boundary only, never transaction guarantees.
const forbidden = () => {
  throw new Error("Validation must reject before accessing the database.");
};
const app = createApp({
  client: {
    db: () => ({ command: async () => ({ isWritablePrimary: true }) }),
  },
  db: { collection: forbidden },
  apiKey,
  webhookSecret,
  logger: { error() {} },
});
const auth = (req) => req.set("Authorization", `Bearer ${apiKey}`);
test("HTTP authentication, type, JSON, size and field validation stop before DB access", async () => {
  const cases = [
    [request(app).post("/v1/transfers").send({}), 401],
    [auth(request(app).post("/v1/transfers")).type("text").send("{}"), 415],
    [
      auth(request(app).post("/v1/transfers")).type("json").send("{broken"),
      400,
    ],
    [
      auth(request(app).post("/v1/transfers")).send({ x: "x".repeat(17000) }),
      413,
    ],
    [
      auth(request(app).post("/v1/transfers")).send({
        fromAccountId: "a",
        toAccountId: "b",
        amount: 1.5,
        currency: "NGN",
      }),
      400,
    ],
    [
      auth(request(app).post("/v1/accounts")).send({
        id: "a",
        currency: "NGN",
        balance: 100,
      }),
      400,
    ],
    [
      auth(request(app).post("/v1/accounts")).send({
        id: "clearing_x",
        currency: "NGN",
      }),
      400,
    ],
    [
      auth(request(app).post("/v1/accounts")).send({
        id: "a",
        currency: "XYZ",
      }),
      400,
    ],
  ];
  for (const [req, status] of cases) {
    const res = await req;
    assert.equal(res.status, status, JSON.stringify(res.body));
    assert.ok(res.body.error.requestId);
    assert.equal(res.headers["x-powered-by"], undefined);
  }
});
test("HTTP rejects unsigned and expired signed webhooks and validates signed payload", async () => {
  assert.equal(
    (await request(app).post("/v1/webhooks/transfers").send({})).status,
    401,
  );
  for (const [body, age, status] of [
    ["{}", 600, 401],
    ["{}", 0, 400],
    ["{broken", 0, 400],
  ]) {
    const timestamp = String(Math.floor(Date.now() / 1000) - age);
    const signature = createHmac("sha256", webhookSecret)
      .update(`${timestamp}.${body}`)
      .digest("hex");
    const res = await request(app)
      .post("/v1/webhooks/transfers")
      .type("json")
      .set("X-Webhook-Timestamp", timestamp)
      .set("X-Webhook-Signature", signature)
      .send(body);
    assert.equal(res.status, status, JSON.stringify(res.body));
  }
});
test("liveness/readiness and explicit limiter behave without leaking secrets", async () => {
  assert.equal((await request(app).get("/health/live")).status, 200);
  assert.equal((await request(app).get("/health/ready")).status, 200);
  const limited = createApp({
    client: {},
    db: {},
    apiKey,
    webhookSecret,
    rateLimit: 1,
  });
  assert.equal((await request(limited).get("/nope")).status, 404);
  const blocked = await request(limited).get("/nope");
  assert.equal(blocked.status, 429);
  assert.equal(blocked.headers["retry-after"], "60");
  assert.equal((await request(limited).get("/health/live")).status, 200);
});

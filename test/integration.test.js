import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { MongoMemoryReplSet } from "mongodb-memory-server";
import { MongoClient } from "mongodb";
import request from "supertest";
import { createApp } from "../src/app.js";
import { initializeDatabase, assertReplicaSet } from "../src/database.js";
const apiKey = "admin-test-".repeat(5),
  webhookSecret = "webhook-test-".repeat(5);
let repl, client, db, app;
const auth = (req) => req.set("Authorization", `Bearer ${apiKey}`);
const transfer = (amount = 100) => ({
  fromAccountId: "alice",
  toAccountId: "bob",
  currency: "NGN",
  amount,
});
async function hook(eventId, idempotencyKey, tx = transfer()) {
  const body = JSON.stringify({ eventId, idempotencyKey, transfer: tx });
  const timestamp = String(Math.floor(Date.now() / 1000));
  const signature = createHmac("sha256", webhookSecret)
    .update(`${timestamp}.${body}`)
    .digest("hex");
  return request(app)
    .post("/v1/webhooks/transfers")
    .set("Content-Type", "application/json")
    .set("X-Webhook-Timestamp", timestamp)
    .set("X-Webhook-Signature", signature)
    .send(body);
}
async function send(key, tx = transfer()) {
  return auth(request(app).post("/v1/transfers"))
    .set("Idempotency-Key", key)
    .send(tx);
}
async function fund(amount = 1000, account = "alice", key = "funding") {
  const res = await hook(key, key, {
    fromAccountId: "clearing_NGN",
    toAccountId: account,
    currency: "NGN",
    amount,
  });
  assert.equal(res.status, 200, JSON.stringify(res.body));
}
before(async () => {
  repl = await MongoMemoryReplSet.create({
    replSet: { count: 1, storageEngine: "wiredTiger" },
  });
  client = await new MongoClient(repl.getUri(), {
    serverSelectionTimeoutMS: 5000,
  }).connect();
  db = client.db("ledgerflow_test");
  await assertReplicaSet(client);
  await initializeDatabase(db);
  app = createApp({
    client,
    db,
    apiKey,
    webhookSecret,
    rateLimit: 10000,
    logger: { error() {} },
  });
});
after(async () => {
  await client?.close();
  await repl?.stop();
});
beforeEach(async () => {
  for (const name of [
    "accounts",
    "transfers",
    "journals",
    "receipts",
    "events",
  ])
    await db.collection(name).deleteMany({});
  await initializeDatabase(db);
  for (const id of ["alice", "bob"]) {
    const res = await auth(request(app).post("/v1/accounts")).send({
      id,
      currency: "NGN",
    });
    assert.equal(res.status, 201, JSON.stringify(res.body));
  }
});
test("100 concurrent deliveries commit one transfer and one journal", async () => {
  await fund();
  const results = await Promise.all(
    Array.from({ length: 100 }, () => hook("evt1", "payment1")),
  );
  for (const res of results)
    assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(new Set(results.map((r) => r.body.transferId)).size, 1);
  assert.equal(await db.collection("transfers").countDocuments({}), 2);
  assert.equal(await db.collection("journals").countDocuments({}), 2);
  assert.equal(
    (await db.collection("accounts").findOne({ _id: "alice" })).balance,
    900,
  );
  assert.equal(
    (await db.collection("accounts").findOne({ _id: "bob" })).balance,
    100,
  );
  const check = await auth(request(app).get("/v1/reconciliation"));
  assert.equal(check.body.ok, true, JSON.stringify(check.body));
});
test("distinct event IDs and REST retries reuse the same business operation", async () => {
  await fund();
  const a = await hook("evtA", "shared");
  const b = await hook("evtB", "shared");
  const c = await send("shared");
  assert.equal(a.status, 200);
  assert.equal(b.status, 200);
  assert.equal(c.status, 200);
  assert.equal(a.body.transferId, b.body.transferId);
  assert.equal(a.body.transferId, c.body.transferId);
  assert.equal(await db.collection("events").countDocuments({}), 3);
});
test("reusing event or idempotency keys with changed payload returns 409", async () => {
  await fund();
  assert.equal((await hook("evt", "key")).status, 200);
  assert.equal((await hook("evt", "other", transfer(101))).status, 409);
  assert.equal((await hook("other", "key", transfer(101))).status, 409);
  assert.equal((await send("key", transfer(101))).status, 409);
});
test("concurrent distinct debits never overdraw a wallet", async () => {
  await fund();
  const results = await Promise.all(
    Array.from({ length: 30 }, (_, i) => send(`pay${i}`)),
  );
  assert.equal(
    results.filter((r) => r.status === 201).length,
    10,
    JSON.stringify(results.map((r) => r.body)),
  );
  assert.equal(results.filter((r) => r.status === 422).length, 20);
  assert.equal(
    (await db.collection("accounts").findOne({ _id: "alice" })).balance,
    0,
  );
  assert.equal(
    (await db.collection("accounts").findOne({ _id: "bob" })).balance,
    1000,
  );
  assert.equal(
    (await auth(request(app).get("/v1/reconciliation"))).body.ok,
    true,
  );
});
test("credit overflow after debit aborts balances, receipt, event and journal", async () => {
  await fund(1000);
  // Inject a destination at its ceiling to force failure AFTER the debit.
  await db
    .collection("accounts")
    .updateOne({ _id: "bob" }, { $set: { balance: 9000000000000 } });
  const before = await db.collection("accounts").findOne({ _id: "alice" });
  const res = await hook("overflow", "overflow", transfer(101));
  assert.equal(res.status, 422, JSON.stringify(res.body));
  assert.equal(
    (await db.collection("accounts").findOne({ _id: "alice" })).balance,
    before.balance,
  );
  assert.equal(
    await db.collection("receipts").countDocuments({ _id: "overflow" }),
    0,
  );
  assert.equal(
    await db.collection("events").countDocuments({ _id: "overflow" }),
    0,
  );
});
test("missing destination and insufficient funds leave no partial records", async () => {
  await fund();
  assert.equal(
    (await send("missing", { ...transfer(), toAccountId: "nobody" })).status,
    404,
  );
  assert.equal((await send("too-much", transfer(1001))).status, 422);
  assert.equal(await db.collection("receipts").countDocuments({}), 1);
  assert.equal(
    (await db.collection("accounts").findOne({ _id: "alice" })).balance,
    1000,
  );
});
test("rejects unsigned, stale, malformed, fractional and unauthorized requests", async () => {
  assert.equal((await request(app).get("/v1/accounts/alice")).status, 401);
  assert.equal(
    (await request(app).post("/v1/webhooks/transfers").send({})).status,
    401,
  );
  for (const amount of [0, -1, 1.1, "100", Number.MAX_SAFE_INTEGER]) {
    assert.equal((await send("invalid", transfer(amount))).status, 400);
  }
  assert.equal(
    (await send("self", { ...transfer(), toAccountId: "alice" })).status,
    400,
  );
  assert.equal(
    (await send("clearing", { ...transfer(), fromAccountId: "clearing_NGN" }))
      .status,
    403,
  );
  assert.equal(
    (
      await auth(request(app).post("/v1/accounts")).send({
        id: "x",
        currency: "NGN",
        balance: 100,
      })
    ).status,
    400,
  );
});
test("reconciliation detects balance tampering and missing journals", async () => {
  await fund();
  await db
    .collection("accounts")
    .updateOne({ _id: "alice" }, { $inc: { balance: 1 } });
  let res = await auth(request(app).get("/v1/reconciliation"));
  assert.equal(res.body.ok, false);
  assert.ok(res.body.issues.some((x) => x.code === "BALANCE_MISMATCH"));
  await db.collection("journals").deleteMany({});
  res = await auth(request(app).get("/v1/reconciliation"));
  assert.ok(res.body.issues.some((x) => x.code === "MISSING_JOURNAL"));
});
test("health and anomaly endpoints respond without making ledger writes", async () => {
  assert.equal((await request(app).get("/health/ready")).status, 200);
  const res = await auth(request(app).post("/v1/anomalies/score")).send({
    accountId: "alice",
    currency: "NGN",
    amount: 100,
  });
  assert.equal(res.status, 200);
  assert.equal(res.body.status, "insufficient_data");
  assert.equal(await db.collection("transfers").countDocuments({}), 0);
});
test("reconciliation reports malformed transfers and event tampering", async () => {
  await fund();
  await db
    .collection("events")
    .updateOne({ _id: "funding" }, { $set: { "result.amount": 999 } });
  let res = await auth(request(app).get("/v1/reconciliation"));
  assert.equal(res.status, 200);
  assert.equal(res.body.ok, false);
  assert.ok(res.body.issues.some((x) => x.code === "INVALID_EVENT"));
  await db
    .collection("transfers")
    .updateOne({}, { $set: { createdAt: "bad-date", amount: 1.5 } });
  res = await auth(request(app).get("/v1/reconciliation"));
  assert.equal(res.status, 200);
  assert.ok(res.body.issues.some((x) => x.code === "INVALID_TRANSFER"));
});

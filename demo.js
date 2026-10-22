import { createHmac } from "node:crypto";
const base = process.env.BASE_URL ?? "http://127.0.0.1:3000";
const suffix = Date.now().toString(36);
const alice = `alice_${suffix}`,
  bob = `bob_${suffix}`;
async function call(path, body, extra = {}) {
  const res = await fetch(base + path, {
    method: body ? "POST" : "GET",
    headers: {
      Authorization: `Bearer ${process.env.API_KEY}`,
      "Content-Type": "application/json",
      ...extra,
    },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(30000),
  });
  const result = await res.json();
  if (!res.ok) throw new Error(`${res.status}: ${JSON.stringify(result)}`);
  return result;
}
for (const id of [alice, bob])
  await call("/v1/accounts", { id, currency: "NGN" });
const settlement = {
  eventId: `evt_${suffix}`,
  idempotencyKey: `settle_${suffix}`,
  transfer: {
    fromAccountId: "clearing_NGN",
    toAccountId: alice,
    currency: "NGN",
    amount: 500000,
  },
};
const raw = JSON.stringify(settlement),
  timestamp = String(Math.floor(Date.now() / 1000));
const signature = createHmac("sha256", process.env.WEBHOOK_SECRET)
  .update(`${timestamp}.${raw}`)
  .digest("hex");
console.log(
  "Settlement:",
  await call("/v1/webhooks/transfers", settlement, {
    "X-Webhook-Timestamp": timestamp,
    "X-Webhook-Signature": signature,
  }),
);
const tx = {
  fromAccountId: alice,
  toAccountId: bob,
  currency: "NGN",
  amount: 125000,
};
const results = await Promise.all(
  Array.from({ length: 20 }, () =>
    call("/v1/transfers", tx, { "Idempotency-Key": `pay_${suffix}` }),
  ),
);
console.log(
  "20 concurrent deliveries; unique transfer IDs:",
  new Set(results.map((x) => x.transferId)).size,
);
console.log("Alice:", await call(`/v1/accounts/${alice}`));
console.log("Bob:", await call(`/v1/accounts/${bob}`));
console.log("Reconciliation:", await call("/v1/reconciliation"));
console.log(
  "Anomaly:",
  await call("/v1/anomalies/score", {
    accountId: alice,
    currency: "NGN",
    amount: 900000,
  }),
);

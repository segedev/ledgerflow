# LedgerFlow

A JavaScript REST API for transaction-backed webhook processing, a double-entry ledger, internal reconciliation, and amount anomaly detection. Built with Node.js, Express and the native MongoDB driver.

## Run locally

Install **Node.js 24+** and **Docker Desktop / Docker Compose**. From this folder:

```sh
npm ci
npm run setup
docker compose up --build -d
npm run demo
```

`setup` creates `.env` with two independent random secrets without overwriting an existing file. Docker starts the API at `http://127.0.0.1:3000` and a persistent single-node MongoDB replica set. The demo creates two wallets, posts a signed settlement, sends 20 concurrent copies of one transfer, and prints balances and reconciliation. Repeating the demo uses new wallet IDs. Expect 1 unique payment transfer ID, Alice at 375000 and Bob at 125000 (₦3,750 and ₦1,250). The initial anomaly result is `insufficient_data`.

To run Node outside Docker instead:

```sh
npm ci
npm run setup
docker compose up -d --wait mongo
npm start
```

In another terminal, run `npm run demo`. For an existing Atlas or replica set, change `MONGODB_URI` in `.env`; a standalone MongoDB instance is rejected at startup. The compose database has no authentication and is intended only for local development. Its published port binds to loopback. Use authenticated TLS connections and a private database network for deployment.

```sh
docker compose down
```

This stops services and retains the named database volume. To inspect logs: `docker compose logs api`.

## What happens to a webhook

1. Verify HMAC-SHA256 over `timestamp + "." + rawBody`, using exact, uncompressed UTF-8 bytes and a five-minute timestamp window.
2. Validate the event ID, signed idempotency key, currency and positive integer amount.
3. Start a MongoDB transaction. Claim event and idempotency identities, debit and credit accounts, write the transfer and balanced journal, then commit.
4. Return HTTP 200 only after commit. On retries, return the original result. Reusing a committed event ID or key for different data returns HTTP 409.

MongoDB `withTransaction` handles retryable transaction errors and uncertain commits. Unique-key races are re-read using a bounded fresh-transaction retry. Every operation in the callback uses the same session, sequentially. All write concerns are journaled majority; read concern is snapshot. The API never sends an external notification inside the transaction callback.

There is no intermediate “processing” receipt left after an aborted operation. Failed operations do not reserve their keys. If a response is lost or a 503 is returned, retry the **same key and payload**; a previous commit may already have succeeded. A provider must retry non-2xx deliveries. A durable queue or outbound notification dispatcher is not included.

## Money and clearing accounts

All amounts use minor units: `10000` means ₦100.00 for NGN. The supported currencies NGN, USD, EUR and GBP use two decimal places here. Cross-currency transfers are rejected. Individual amounts and absolute account balances are capped at `9000000000000`, comfortably inside JavaScript's safe integer range. No floating-point amounts are accepted.

Wallets start at zero. Startup creates `clearing_NGN`, `clearing_USD`, `clearing_EUR` and `clearing_GBP`. A trusted signed settlement transfers from a clearing account into a wallet. Clearing accounts may become negative to represent external funding; ordinary wallets may not. REST clients cannot debit clearing accounts. Returns to clearing represent funds leaving a wallet. These entries model money; this project does **not** move actual bank funds or independently verify a bank settlement.

The webhook signing secret therefore authorizes funding and must belong only to a trusted settlement adapter. This is a documented custom webhook protocol, not an implementation of Stripe or Paystack's native signature schemes.

## API

All `/v1` routes except the signed webhook require `Authorization: Bearer <API_KEY>`. This is a **single-tenant administrator API**, not end-user authorization. All POST bodies require `Content-Type: application/json`. Unknown body fields are rejected, bodies are limited to 16 KiB, and compressed payloads are rejected.

| Method | Path                     | Purpose                                |
| ------ | ------------------------ | -------------------------------------- |
| GET    | `/health/live`           | Process liveness                       |
| GET    | `/health/ready`          | Writable MongoDB topology available    |
| POST   | `/v1/accounts`           | Create zero-balance wallet             |
| GET    | `/v1/accounts/:id`       | Account and cached balance             |
| POST   | `/v1/transfers`          | Transfer with `Idempotency-Key` header |
| GET    | `/v1/transfers/:id`      | Read a committed transfer              |
| POST   | `/v1/webhooks/transfers` | Signed settlement or transfer          |
| GET    | `/v1/reconciliation`     | Snapshot integrity check               |
| POST   | `/v1/anomalies/score`    | Score amount against account history   |

IDs contain 1–80 letters, digits, `_` or `-`. The `clearing_` prefix is reserved. Idempotency keys contain 1–128 letters, digits, `_`, `.`, `:` or `-`. Keys are globally scoped to this single tenant across REST and the configured webhook provider; use the same key for retries and new keys for distinct operations. Receipts and events are permanent, with no TTL. Another provider requires a separately authenticated adapter and deliberate identity namespacing.

Create account:

```json
{ "id": "alice", "currency": "NGN" }
```

Transfer (`Idempotency-Key: order_101`):

```json
{
  "fromAccountId": "alice",
  "toAccountId": "bob",
  "currency": "NGN",
  "amount": 125000
}
```

New REST transfers return 201; replays return 200. Example response:

```json
{
  "transferId": "<uuid>",
  "fromAccountId": "alice",
  "toAccountId": "bob",
  "amount": 125000,
  "currency": "NGN",
  "createdAt": "<ISO timestamp>",
  "replayed": false
}
```

Webhook body:

```json
{
  "eventId": "evt_101",
  "idempotencyKey": "settlement_101",
  "transfer": {
    "fromAccountId": "clearing_NGN",
    "toAccountId": "alice",
    "currency": "NGN",
    "amount": 500000
  }
}
```

Sign before transmitting; do not reserialize after signing:

```js
import { createHmac } from "node:crypto";
const rawBody = JSON.stringify(event);
const timestamp = String(Math.floor(Date.now() / 1000));
const signature = createHmac("sha256", process.env.WEBHOOK_SECRET)
  .update(`${timestamp}.${rawBody}`)
  .digest("hex");
const response = await fetch("http://127.0.0.1:3000/v1/webhooks/transfers", {
  method: "POST",
  headers: {
    "Content-Type": "application/json",
    "X-Webhook-Timestamp": timestamp,
    "X-Webhook-Signature": signature,
  },
  body: rawBody,
});
```

Use a fresh timestamp and signature for a delayed retry, with the original event ID, key and transfer data. The signed key lives in the body so intermediaries cannot change the business identity by modifying an unsigned header. Field order and whitespace can differ between freshly signed retries because conflict checks hash normalized financial fields. Different IDs **and** different keys will be treated as different transfers even when amounts and accounts match.

Errors have `{ "error": { "code", "message", "requestId" } }`. Main status codes: 400 validation/JSON; 401 authentication/signature; 403 clearing permission; 404 missing account/transfer; 409 conflicting identity; 413 body size; 415 content encoding/type; 422 insufficient funds/currency/balance/scan limit; 429 overload; 503 database or uncertain result. Request IDs are generated by the service and returned in `X-Request-Id`. Logs omit body contents, keys and database connection strings.

## Reconciliation

This is **internal ledger reconciliation**. A snapshot reads all five collections consistently, rebuilds balances using BigInt, compares entries with transfers and cached balances, checks receipt/event links and verifies per-currency totals sum to zero. Reports never repair or overwrite evidence. System clearing accounts are included in zero totals.

A healthy response contains `ok: true`, document counts, zero currency totals as strings, and an empty `issues` array. A discrepancy returns 200 with `ok: false`: the audit completed but found an integrity problem. At most 200 issues are returned; `issueCount` and `truncated` expose omitted issues. The online scan is capped at 50,000 documents **per collection**. Use an offline snapshot audit or incremental reconciliation design above that limit. This is not matching against bank statements or a mechanism to detect a privileged attacker rewriting every related record consistently.

## AI anomaly detection

Request:

```json
{ "accountId": "alice", "currency": "NGN", "amount": 900000 }
```

The service trains a seeded 100-tree **Isolation Forest** on `log(1 + amount)` from up to 2,000 recent outgoing transfers for the same account and currency. It uses subsamples of at most 128 rows and depth `ceil(log2(sampleSize))`. This is an actual unsupervised model, with no external API key or data transmission. It does not use an LLM.

With fewer than 30 samples, it returns `status: "insufficient_data"`, `score: null` and `flagged: null`. Otherwise it returns the model version, amount feature, sample count, score and an illustrative threshold of 0.58. A constant training set uses an explicit equality/deviation rule because isolation trees cannot split it. Seeded sampling makes a fixed history reproducible. The model is trained per request and is intended for modest traffic.

A score is **not a fraud probability**. Amount-only detection misses other fraud patterns and can flag legitimate unusual payments. Isolation Forest scores can saturate outside the training range. This initial threshold needs evaluation against real labeled outcomes and desired false-positive rates. No fraud-accuracy metrics are claimed. Scoring is read-only and cannot authorize or block money movement.

## Tests

```sh
npm test
npm run test:unit
npm audit --omit=dev
```

The full test suite starts a disposable **real MongoDB replica set** using `mongodb-memory-server`; despite the package name, it runs the MongoDB server with WiredTiger. It requires permission to run local processes and download a MongoDB binary on the first run. Integration tests use an isolated database, never your `.env` connection. Tests fail rather than silently skip if MongoDB cannot start.

Coverage includes 100 concurrent duplicate webhook deliveries, event/key conflicts, cross-channel retries, competing debits, rollback after a debit, exact signed bytes, timestamp expiry, invalid amounts, access control, reconciliation discrepancies and anomaly cold starts/outliers. These tests verify correctness scenarios, not a throughput benchmark or a multi-node failover certification.

## Files

- `src/ledger.js`: atomic money movement and idempotency.
- `src/database.js`: topology checks, indexes and transaction settings.
- `src/security.js`, `src/validation.js`: cryptography and request contracts.
- `src/reconciliation.js`: internal integrity audit.
- `src/anomaly.js`: deterministic amount Isolation Forest.
- `src/app.js`, `src/server.js`: REST boundary and lifecycle.
- `scripts/demo.js`, `scripts/setup.js`: end-to-end example and configuration.
- `test/`: meaningful security, model and replica-set tests.
- `docs/`: design, implementation plan, API specification and verification record.

## Deployment boundaries

Use a multi-node authenticated replica set, TLS, private networking, a secret manager and backups with verified restores for production. The included single-node compose setup does not survive node loss. Enforce distributed ingress rate limiting, provider-specific secrets/rotation, least-privilege database roles and end-user/tenant authorization before exposing this to customers. The included limiter is a global, per-process 1,000-request/minute circuit breaker, not a distributed abuse control. Live/ready probes bypass it. Snapshot isolation is not general serializability; the money invariants here rely on both account documents being updated with conditional writes.

There is no unconditional “zero data corruption” claim. Protection applies to the documented API paths, stable identities, successful transaction commits and database guarantees. Network partitions, provider semantics, privileged direct DB changes and operational failure require additional controls and testing. Journal records are append-only through this API; database administrators can still modify them. Transfers must be reversed with a new opposite transfer and key; no destructive edit endpoint exists.

Primary references: [MongoDB Node transactions](https://www.mongodb.com/docs/drivers/node/current/crud/transactions/), [MongoDB transaction considerations](https://www.mongodb.com/docs/manual/core/transactions-production-consideration/), [Node crypto HMAC and timingSafeEqual](https://nodejs.org/api/crypto.html), [Isolation Forest original paper (Liu, Ting & Zhou, 2008)](https://cs.nju.edu.cn/zhouzh/zhouzh.files/publication/icdm08b.pdf).

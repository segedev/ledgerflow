import test from "node:test";
import assert from "node:assert/strict";
import { auditSnapshot } from "../src/reconciliation.js";
import { fingerprint } from "../src/security.js";
function fixture() {
  const createdAt = new Date("2026-10-22T10:00:00Z");
  const fields = {
    fromAccountId: "clearing_NGN",
    toAccountId: "alice",
    amount: 100,
    currency: "NGN",
  };
  const result = {
    transferId: "tx1",
    ...fields,
    createdAt: createdAt.toISOString(),
  };
  return {
    accounts: [
      { _id: "clearing_NGN", kind: "clearing", currency: "NGN", balance: -100 },
      { _id: "alice", kind: "wallet", currency: "NGN", balance: 100 },
    ],
    transfers: [{ _id: "tx1", ...fields, createdAt }],
    journals: [
      {
        _id: "tx1",
        transferId: "tx1",
        currency: "NGN",
        entries: [
          { accountId: "clearing_NGN", delta: -100 },
          { accountId: "alice", delta: 100 },
        ],
      },
    ],
    receipts: [{ _id: "fund1", requestHash: fingerprint(fields), result }],
    events: [
      {
        _id: "evt1",
        idempotencyKey: "fund1",
        requestHash: fingerprint({ idempotencyKey: "fund1", transfer: fields }),
        result,
      },
    ],
  };
}
test("audit reconstructs a healthy snapshot with exact totals", () => {
  const result = auditSnapshot(fixture());
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.deepEqual(result.currencyTotals, { NGN: "0" });
});
test("audit detects tampering with event amount and fingerprints", () => {
  const data = fixture();
  data.events[0] = {
    ...data.events[0],
    result: { ...data.events[0].result, amount: 999 },
  };
  assert.ok(auditSnapshot(data).issues.some((x) => x.code === "INVALID_EVENT"));
});
test("malformed dates, numeric balances and transfers report issues instead of crashing", () => {
  const data = fixture();
  data.transfers[0].createdAt = "bad-date";
  data.transfers[0].amount = 1.5;
  data.accounts[0].balance = "bad";
  const result = auditSnapshot(data);
  assert.equal(result.ok, false);
  assert.ok(result.issues.some((x) => x.code === "INVALID_TRANSFER"));
  assert.ok(result.issues.some((x) => x.code === "INVALID_BALANCE"));
});
test("audit detects missing journals and limits returned issue details", () => {
  const data = fixture();
  data.journals = [];
  assert.ok(
    auditSnapshot(data).issues.some((x) => x.code === "MISSING_JOURNAL"),
  );
  data.accounts = Array.from({ length: 300 }, (_, i) => ({
    _id: `bad${i}`,
    kind: "wallet",
    currency: "NGN",
    balance: 1,
  }));
  const result = auditSnapshot(data);
  assert.equal(result.issues.length, 200);
  assert.equal(result.truncated, true);
  assert.ok(result.issueCount > 200);
});

test("malformed journal entries and unexpected currencies report issues", () => {
  const data = fixture();
  data.journals[0].entries = [null, { accountId: "alice", delta: 100 }];
  data.accounts[0].currency = "__proto__";
  const result = auditSnapshot(data);
  assert.equal(result.ok, false);
  assert.ok(result.issues.some((x) => x.code === "INVALID_JOURNAL"));
  assert.ok(result.issues.some((x) => x.code === "INVALID_ACCOUNT"));
});

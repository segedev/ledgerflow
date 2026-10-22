import { transactionOptions } from "./database.js";
import { fail } from "./errors.js";
import { validateTransfer, LIMIT, CURRENCIES } from "./validation.js";
import { fingerprint } from "./security.js";
const MAX_RECORDS = 50000;
const transferFields = (t = {}) => ({
  fromAccountId: t.fromAccountId,
  toAccountId: t.toAccountId,
  amount: t.amount,
  currency: t.currency,
});
const isoDate = (d) =>
  d instanceof Date && Number.isFinite(d.getTime()) ? d.toISOString() : null;
export async function reconcile({ client, db }) {
  const session = client.startSession();
  try {
    return await session.withTransaction(async () => {
      const data = {};
      for (const name of [
        "accounts",
        "transfers",
        "journals",
        "receipts",
        "events",
      ]) {
        data[name] = await db
          .collection(name)
          .find({}, { session, maxTimeMS: 5000 })
          .limit(MAX_RECORDS + 1)
          .toArray();
        if (data[name].length > MAX_RECORDS)
          fail(
            422,
            "RECONCILIATION_LIMIT",
            "Full reconciliation is limited to 50,000 documents per collection; use an offline snapshot audit for larger ledgers.",
          );
      }
      return auditSnapshot(data);
    }, transactionOptions);
  } finally {
    await session.endSession();
  }
}

export function auditSnapshot(data) {
  const issues = [];
  let issueCount = 0;
  const add = (issue) => {
    issueCount++;
    if (issues.length < 200) issues.push(issue);
  };
  const accounts = new Map(data.accounts.map((a) => [a._id, a]));
  const transfers = new Map(data.transfers.map((t) => [t._id, t]));
  const journals = new Map(data.journals.map((j) => [j.transferId, j]));
  const totals = new Map(data.accounts.map((a) => [a._id, 0n]));
  for (const journal of data.journals) {
    const t = transfers.get(journal.transferId);
    const entries = journal.entries;
    if (!t) add({ code: "ORPHAN_JOURNAL", journalId: journal._id });
    const valid =
      Array.isArray(entries) &&
      entries.length === 2 &&
      entries.every(
        (e) =>
          e &&
          Number.isSafeInteger(e.delta) &&
          e.delta !== 0 &&
          typeof e.accountId === "string",
      );
    if (!valid) {
      add({ code: "INVALID_JOURNAL", journalId: journal._id });
      continue;
    }
    if (entries.reduce((sum, e) => sum + BigInt(e.delta), 0n) !== 0n)
      add({ code: "UNBALANCED_JOURNAL", journalId: journal._id });
    if (
      t &&
      (journal._id !== t._id ||
        journal.currency !== t.currency ||
        entries[0].accountId !== t.fromAccountId ||
        entries[0].delta !== -t.amount ||
        entries[1].accountId !== t.toAccountId ||
        entries[1].delta !== t.amount)
    )
      add({ code: "JOURNAL_TRANSFER_MISMATCH", transferId: t._id });
    for (const entry of entries) {
      const account = accounts.get(entry.accountId);
      if (!account || account.currency !== journal.currency)
        add({
          code: "JOURNAL_ACCOUNT_MISMATCH",
          journalId: journal._id,
          accountId: entry.accountId,
        });
      totals.set(
        entry.accountId,
        (totals.get(entry.accountId) ?? 0n) + BigInt(entry.delta),
      );
    }
  }
  const currencyTotals = new Map();
  for (const a of data.accounts) {
    if (!Number.isSafeInteger(a.balance)) {
      add({ code: "INVALID_BALANCE", accountId: a._id });
      continue;
    }
    if (BigInt(a.balance) !== totals.get(a._id))
      add({
        code: "BALANCE_MISMATCH",
        accountId: a._id,
        storedBalance: String(a.balance),
        journalBalance: String(totals.get(a._id)),
      });
    if (
      !CURRENCIES.includes(a.currency) ||
      !["wallet", "clearing"].includes(a.kind) ||
      Math.abs(a.balance) > LIMIT ||
      (a.kind === "clearing" && a._id !== `clearing_${a.currency}`)
    )
      add({ code: "INVALID_ACCOUNT", accountId: a._id });
    if (a.kind === "wallet" && a.balance < 0)
      add({ code: "NEGATIVE_WALLET", accountId: a._id });
    currencyTotals.set(
      a.currency,
      (currencyTotals.get(a.currency) ?? 0n) + BigInt(a.balance),
    );
  }
  const receiptsByTransfer = new Map();
  for (const r of data.receipts) {
    const t = transfers.get(r.result?.transferId);
    if (
      !t ||
      r.requestHash !== fingerprint(transferFields(t)) ||
      fingerprint(transferFields(r.result)) !==
        fingerprint(transferFields(t)) ||
      r.result.createdAt !== isoDate(t.createdAt)
    )
      add({ code: "INVALID_RECEIPT", key: r._id });
    receiptsByTransfer.set(
      r.result?.transferId,
      (receiptsByTransfer.get(r.result?.transferId) ?? 0) + 1,
    );
  }
  for (const t of data.transfers) {
    try {
      validateTransfer(transferFields(t));
      if (!isoDate(t.createdAt)) throw new Error("Invalid date");
    } catch {
      add({ code: "INVALID_TRANSFER", transferId: t._id });
    }
    if (!journals.has(t._id))
      add({ code: "MISSING_JOURNAL", transferId: t._id });
    if (receiptsByTransfer.get(t._id) !== 1)
      add({ code: "RECEIPT_COUNT_MISMATCH", transferId: t._id });
  }
  const receiptsByKey = new Map(data.receipts.map((r) => [r._id, r]));
  for (const event of data.events) {
    const t = transfers.get(event.result?.transferId);
    const receipt = receiptsByKey.get(event.idempotencyKey);
    if (
      !t ||
      !receipt ||
      receipt.result?.transferId !== t._id ||
      fingerprint(transferFields(event.result)) !==
        fingerprint(transferFields(t)) ||
      event.result.createdAt !== isoDate(t.createdAt) ||
      event.requestHash !==
        fingerprint({
          idempotencyKey: event.idempotencyKey,
          transfer: transferFields(t),
        })
    )
      add({ code: "INVALID_EVENT", eventId: event._id });
  }
  for (const [currency, total] of currencyTotals.entries()) {
    if (total !== 0n)
      add({ code: "CURRENCY_NOT_BALANCED", currency, total: String(total) });
  }
  return {
    ok: issueCount === 0,
    checkedAt: new Date().toISOString(),
    counts: Object.fromEntries(
      Object.entries(data).map(([k, v]) => [k, v.length]),
    ),
    currencyTotals: Object.fromEntries(
      currencyTotals.entries().map(([k, v]) => [k, String(v)]),
    ),
    issueCount,
    issues,
    truncated: issueCount > issues.length,
  };
}

import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { transactionOptions } from "./database.js";
import { fingerprint } from "./security.js";
import { LIMIT } from "./validation.js";
import { fail } from "./errors.js";

/** All mutations are sequential in the same session; no network side effects in the retryable callback. */
export async function postTransfer({
  client,
  db,
  transfer,
  idempotencyKey,
  eventId,
  allowClearing = false,
}) {
  if (!allowClearing && transfer.fromAccountId.startsWith("clearing_"))
    fail(
      403,
      "CLEARING_RESTRICTED",
      "Only authenticated settlement webhooks can debit clearing accounts.",
    );
  const requestHash = fingerprint(transfer);
  const eventHash = eventId
    ? fingerprint({ idempotencyKey, transfer })
    : undefined;
  const transferId = randomUUID();
  const createdAt = new Date();
  for (let attempt = 0; attempt < 6; attempt++) {
    const session = client.startSession();
    try {
      return await session.withTransaction(async () => {
        if (eventId) {
          const event = await db
            .collection("events")
            .findOne({ _id: eventId }, { session });
          if (event) {
            if (event.requestHash !== eventHash)
              fail(
                409,
                "EVENT_CONFLICT",
                "Event ID already belongs to another payload.",
              );
            return { result: event.result, replayed: true };
          }
        }
        const receipt = await db
          .collection("receipts")
          .findOne({ _id: idempotencyKey }, { session });
        if (receipt) {
          if (receipt.requestHash !== requestHash)
            fail(
              409,
              "IDEMPOTENCY_CONFLICT",
              "Idempotency key already belongs to another transfer.",
            );
          if (eventId)
            await db
              .collection("events")
              .insertOne(
                {
                  _id: eventId,
                  idempotencyKey,
                  requestHash: eventHash,
                  result: receipt.result,
                  createdAt,
                },
                { session },
              );
          return { result: receipt.result, replayed: true };
        }
        const result = {
          transferId,
          ...transfer,
          createdAt: createdAt.toISOString(),
        };
        // Claim both identities inside the SAME transaction as the money movement.
        await db
          .collection("receipts")
          .insertOne(
            { _id: idempotencyKey, requestHash, result, createdAt },
            { session },
          );
        if (eventId)
          await db
            .collection("events")
            .insertOne(
              {
                _id: eventId,
                idempotencyKey,
                requestHash: eventHash,
                result,
                createdAt,
              },
              { session },
            );
        const source = await db
          .collection("accounts")
          .findOne({ _id: transfer.fromAccountId }, { session });
        const destination = await db
          .collection("accounts")
          .findOne({ _id: transfer.toAccountId }, { session });
        if (!source || !destination)
          fail(
            404,
            "ACCOUNT_NOT_FOUND",
            "Source or destination account does not exist.",
          );
        if (
          source.currency !== transfer.currency ||
          destination.currency !== transfer.currency
        )
          fail(
            422,
            "CURRENCY_MISMATCH",
            "Both accounts must use the transfer currency.",
          );
        if (source.kind === "clearing" && !allowClearing)
          fail(
            403,
            "CLEARING_RESTRICTED",
            "Only settlement webhooks may debit clearing accounts.",
          );
        const minimum = source.kind === "clearing" ? -LIMIT : 0;
        const debit = await db.collection("accounts").updateOne(
          {
            _id: source._id,
            balance: { $gte: minimum + transfer.amount },
          },
          { $inc: { balance: -transfer.amount } },
          { session },
        );
        if (debit.modifiedCount !== 1)
          fail(
            422,
            "INSUFFICIENT_FUNDS",
            "Debit would exceed the account balance or clearing limit.",
          );
        const credit = await db.collection("accounts").updateOne(
          {
            _id: destination._id,
            balance: { $lte: LIMIT - transfer.amount },
          },
          { $inc: { balance: transfer.amount } },
          { session },
        );
        if (credit.modifiedCount !== 1)
          fail(422, "BALANCE_LIMIT", "Credit would exceed the balance limit.");
        await db
          .collection("transfers")
          .insertOne({ _id: transferId, ...transfer, createdAt }, { session });
        await db.collection("journals").insertOne(
          {
            _id: transferId,
            transferId,
            currency: transfer.currency,
            entries: [
              { accountId: source._id, delta: -transfer.amount },
              { accountId: destination._id, delta: transfer.amount },
            ],
            createdAt,
          },
          { session },
        );
        return { result, replayed: false };
      }, transactionOptions);
    } catch (error) {
      // Unique-key races abort the whole transaction. Re-read committed identities
      // in a fresh transaction; never assume every duplicate is a successful replay.
      if (error.code !== 11000 || attempt === 5) throw error;
      await delay(10 * (attempt + 1));
    } finally {
      await session.endSession();
    }
  }
}

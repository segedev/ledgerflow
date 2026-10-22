import { CURRENCIES } from "./validation.js";
export const transactionOptions = {
  readConcern: { level: "snapshot" },
  writeConcern: { w: "majority", j: true },
  readPreference: "primary",
  maxCommitTimeMS: 10000,
  timeoutMS: 20000,
};
export async function assertReplicaSet(client) {
  const hello = await client.db("admin").command({ hello: 1 });
  if (!hello.setName && hello.msg !== "isdbgrid")
    throw new Error(
      "MongoDB must be a replica set or sharded cluster; standalone mode cannot provide multi-document transactions.",
    );
}
export async function initializeDatabase(db) {
  for (const name of [
    "accounts",
    "transfers",
    "journals",
    "receipts",
    "events",
  ]) {
    if (!(await db.listCollections({ name }).hasNext()))
      await db.createCollection(name);
  }
  await db
    .collection("transfers")
    .createIndex({ fromAccountId: 1, currency: 1, createdAt: -1, _id: -1 });
  await db
    .collection("journals")
    .createIndex({ transferId: 1 }, { unique: true });
  for (const currency of CURRENCIES) {
    await db.collection("accounts").updateOne(
      { _id: `clearing_${currency}` },
      {
        $setOnInsert: {
          currency,
          kind: "clearing",
          balance: 0,
          createdAt: new Date(),
        },
      },
      { upsert: true },
    );
  }
  // _id is the permanent, unique identity for accounts, receipts and events.
  // Never TTL financial idempotency receipts: an expired key could apply twice.
}

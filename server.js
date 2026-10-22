import { MongoClient } from "mongodb";
import { createApp } from "./app.js";
import { assertReplicaSet, initializeDatabase } from "./database.js";
const required = (name) => {
  const value = process.env[name];
  if (!value || value.startsWith("replace-"))
    throw new Error(`${name} must be configured.`);
  return value;
};
let client, server;
try {
  const apiKey = required("API_KEY"),
    webhookSecret = required("WEBHOOK_SECRET");
  const port = Number(process.env.PORT ?? 3000);
  if (!Number.isInteger(port) || port < 1 || port > 65535)
    throw new Error("PORT must be 1–65535.");
  client = new MongoClient(required("MONGODB_URI"), {
    serverSelectionTimeoutMS: 5000,
    maxPoolSize: 50,
    timeoutMS: 20000,
  });
  await client.connect();
  await assertReplicaSet(client);
  const db = client.db(process.env.MONGODB_DB ?? "ledgerflow");
  await initializeDatabase(db);
  const app = createApp({ client, db, apiKey, webhookSecret });
  server = app.listen(port, process.env.HOST ?? "127.0.0.1", () =>
    console.log(`LedgerFlow listening on port ${port}`),
  );
  server.requestTimeout = 30000;
  server.headersTimeout = 15000;
  server.on("error", async (error) => {
    console.error({ event: "listen_failed", errorName: error.name });
    await client.close();
    process.exitCode = 1;
  });
} catch (error) {
  console.error({
    event: "startup_failed",
    message: error.name?.startsWith("Mongo")
      ? "MongoDB connection or initialization failed. Check replica set and credentials."
      : error.message,
  });
  await client?.close();
  process.exitCode = 1;
}
let closing = false;
async function shutdown() {
  if (closing) return;
  closing = true;
  const deadline = setTimeout(() => process.exit(1), 25000);
  deadline.unref();
  if (server?.listening) await new Promise((resolve) => server.close(resolve));
  await client?.close();
  clearTimeout(deadline);
}
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);

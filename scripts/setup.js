import { randomBytes } from "node:crypto";
import { writeFile } from "node:fs/promises";
const text = `MONGODB_URI=mongodb://127.0.0.1:27017/ledgerflow?replicaSet=rs0&directConnection=true
MONGODB_DB=ledgerflow
API_KEY=${randomBytes(32).toString("hex")}
WEBHOOK_SECRET=${randomBytes(32).toString("hex")}
PORT=3000
HOST=127.0.0.1
`;
try {
  await writeFile(new URL("../.env", import.meta.url), text, {
    flag: "wx",
    mode: 0o600,
  });
  console.log("Created .env with independent random secrets.");
} catch (error) {
  if (error.code === "EEXIST")
    console.log(".env already exists; kept existing settings.");
  else throw error;
}

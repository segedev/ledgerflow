import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { fail } from "./errors.js";
export const fingerprint = (value) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");
export function secureEqual(a, b) {
  if (typeof a !== "string" || typeof b !== "string") return false;
  const left = createHash("sha256").update(a).digest();
  const right = createHash("sha256").update(b).digest();
  return timingSafeEqual(left, right);
}
export function verifyWebhook({
  raw,
  timestamp,
  signature,
  secret,
  now = Date.now(),
}) {
  if (
    !Buffer.isBuffer(raw) ||
    typeof timestamp !== "string" ||
    !/^\d{10}$/.test(timestamp) ||
    typeof signature !== "string" ||
    !/^[a-f0-9]{64}$/.test(signature) ||
    Math.abs(now / 1000 - Number(timestamp)) > 300
  )
    fail(
      401,
      "INVALID_SIGNATURE",
      "Webhook signature or timestamp is invalid.",
    );
  const expected = createHmac("sha256", secret)
    .update(timestamp + ".")
    .update(raw)
    .digest();
  if (!timingSafeEqual(expected, Buffer.from(signature, "hex")))
    fail(
      401,
      "INVALID_SIGNATURE",
      "Webhook signature or timestamp is invalid.",
    );
}

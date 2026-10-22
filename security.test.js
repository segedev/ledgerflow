import test from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { verifyWebhook } from "../src/security.js";
const secret = "a".repeat(40);
const raw = Buffer.from('{"amount":100}');
const timestamp = "1792666800";
const signature = createHmac("sha256", secret)
  .update(timestamp + ".")
  .update(raw)
  .digest("hex");
const verify = (
  body = raw,
  ts = timestamp,
  sig = signature,
  now = Number(timestamp) * 1000,
) => verifyWebhook({ raw: body, timestamp: ts, signature: sig, secret, now });
test("verifies the exact signed bytes", () =>
  assert.doesNotThrow(() => verify()));
test("rejects changed bytes, expired/future timestamps, malformed and missing signatures", () => {
  for (const args of [
    [Buffer.from('{"amount":101}')],
    [raw, timestamp, signature, Number(timestamp) * 1000 + 301000],
    [raw, timestamp, signature, Number(timestamp) * 1000 - 301000],
    [raw, timestamp, "no"],
    [raw, "", signature],
    [raw, timestamp, null],
    [raw, timestamp + "x", signature],
  ]) {
    assert.throws(() => verify(...args), { code: "INVALID_SIGNATURE" });
  }
});

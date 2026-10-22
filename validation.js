import { fail } from "./errors.js";
export const LIMIT = 9_000_000_000_000;
export const CURRENCIES = ["NGN", "USD", "GBP", "EUR"];
export function object(value, fields) {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).some((key) => !fields.includes(key))
  )
    fail(
      400,
      "INVALID_BODY",
      "Expected an object with only the documented fields.",
    );
}
export function identifier(value, name = "id") {
  if (typeof value !== "string" || !/^[a-zA-Z0-9_-]{1,80}$/.test(value))
    fail(
      400,
      "INVALID_FIELD",
      `${name} must contain 1–80 letters, digits, underscores or hyphens.`,
    );
  return value;
}
export function key(value) {
  if (typeof value !== "string" || !/^[a-zA-Z0-9_.:-]{1,128}$/.test(value))
    fail(
      400,
      "INVALID_KEY",
      "An idempotency key of 1–128 letters, digits, _, ., : or - is required.",
    );
  return value;
}
export function money(amount, currency) {
  if (!Number.isSafeInteger(amount) || amount <= 0 || amount > LIMIT)
    fail(
      400,
      "INVALID_AMOUNT",
      `amount must be an integer from 1 to ${LIMIT} in minor units.`,
    );
  if (!CURRENCIES.includes(currency))
    fail(
      400,
      "INVALID_CURRENCY",
      `currency must be one of ${CURRENCIES.join(", ")}.`,
    );
}
export function validateTransfer(body) {
  object(body, ["fromAccountId", "toAccountId", "amount", "currency"]);
  const { fromAccountId, toAccountId, amount, currency } = body;
  identifier(fromAccountId, "fromAccountId");
  identifier(toAccountId, "toAccountId");
  money(amount, currency);
  if (fromAccountId === toAccountId)
    fail(400, "SELF_TRANSFER", "Source and destination must differ.");
  // Fixed field order gives semantically identical JSON the same fingerprint.
  return { fromAccountId, toAccountId, amount, currency };
}

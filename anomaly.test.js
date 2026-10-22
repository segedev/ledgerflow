import test from "node:test";
import assert from "node:assert/strict";
import { detectAnomaly } from "../src/anomaly.js";
const history = Array.from({ length: 150 }, (_, i) => ({
  amount: 1000 + (i % 17) * 10,
}));
test("cold start reports insufficient data without invented confidence", () => {
  assert.equal(detectAnomaly([], 1000).status, "insufficient_data");
});
test("Isolation Forest ranks an extreme amount above an ordinary amount reproducibly", () => {
  const normal = detectAnomaly(history, 1080);
  const extreme = detectAnomaly(history, 1000000);
  assert.ok(extreme.score > normal.score, JSON.stringify({ normal, extreme }));
  assert.equal(extreme.flagged, true);
  assert.deepEqual(extreme, detectAnomaly(history, 1000000));
  assert.equal(extreme.model, "isolation-forest-v1");
});
test("constant histories remain finite and identify a deviation", () => {
  const data = Array.from({ length: 40 }, () => ({ amount: 1000 }));
  assert.ok(Number.isFinite(detectAnomaly(data, 1000).score));
  assert.equal(detectAnomaly(data, 100000).flagged, true);
});

// Seeded one-dimensional Isolation Forest: isolates unusual log(amount) values.
// Amount-only intentionally avoids sending financial records to an external AI API.
function rng(seed) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const averagePath = (n) =>
  n <= 1
    ? 0
    : n === 2
      ? 1
      : 2 * (Math.log(n - 1) + 0.5772156649) - (2 * (n - 1)) / n;
function build(values, depth, maxDepth, random) {
  const min = Math.min(...values),
    max = Math.max(...values);
  if (depth >= maxDepth || values.length <= 1 || min === max)
    return { size: values.length };
  const split = min + (max - min) * (0.000001 + random() * 0.999998);
  return {
    split,
    left: build(
      values.filter((x) => x < split),
      depth + 1,
      maxDepth,
      random,
    ),
    right: build(
      values.filter((x) => x >= split),
      depth + 1,
      maxDepth,
      random,
    ),
  };
}
function path(node, value, depth = 0) {
  return node.size !== undefined
    ? depth + averagePath(node.size)
    : path(value < node.split ? node.left : node.right, value, depth + 1);
}
export function detectAnomaly(history, amount) {
  const metadata = {
    model: "isolation-forest-v1",
    features: ["logAmount"],
    sampleCount: history.length,
  };
  if (history.length < 30)
    return {
      ...metadata,
      status: "insufficient_data",
      requiredSamples: 30,
      score: null,
      flagged: null,
    };
  const values = history.map((x) => Math.log1p(x.amount));
  const candidate = Math.log1p(amount);
  const random = rng(42),
    size = Math.min(128, values.length);
  const maxDepth = Math.ceil(Math.log2(size));
  let total = 0;
  for (let i = 0; i < 100; i++) {
    const shuffled = [...values];
    for (let j = shuffled.length - 1; j > 0; j--) {
      const k = Math.floor(random() * (j + 1));
      [shuffled[j], shuffled[k]] = [shuffled[k], shuffled[j]];
    }
    total += path(
      build(shuffled.slice(0, size), 0, maxDepth, random),
      candidate,
    );
  }
  let score = 2 ** (-(total / 100) / averagePath(size));
  // A constant training set cannot be split. Handle its degenerate distribution explicitly.
  if (values.every((x) => x === values[0]))
    score = candidate === values[0] ? 0.5 : 1;
  return {
    ...metadata,
    status: "scored",
    score: Number(score.toFixed(6)),
    threshold: 0.58,
    flagged: score >= 0.58,
    explanation:
      "Unsupervised amount outlier score, not a probability of fraud. Threshold is not calibrated to your business.",
  };
}

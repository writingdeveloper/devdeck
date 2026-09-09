import assert from 'node:assert/strict';

/** Low CPU cannot pass a benchmark whose workload never ran. */
export function requireWorkload({ requested, opened, visible }) {
  assert.ok(Number.isInteger(requested) && requested >= 1 && requested <= 16, 'request 1–16 sessions');
  assert.equal(opened, requested, 'every requested terminal must open');
  assert.ok(visible > 0, 'at least one terminal must be on screen');
}
export function requireCpuSamples(samples) {
  assert.ok(samples.has('Browser') && samples.has('Tab'), 'main and renderer CPU samples are required');
  for (const value of samples.values()) assert.ok(Number.isFinite(value) && value >= 0, 'CPU measurements must be finite and nonnegative');
}

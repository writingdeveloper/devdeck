import { describe, it, expect } from 'vitest';
import { requireWorkload, requireCpuSamples } from './perf-validity.mjs';
const valid = { requested: 4, opened: 4, visible: 1 };
describe('performance workload validity', () => {
  it('accepts a real measured workload', () => {
    expect(() => requireWorkload(valid)).not.toThrow();
    expect(() => requireCpuSamples(new Map([['Browser', 0], ['Tab', 1]]))).not.toThrow();
  });
  it.each([{ opened: 0 }, { opened: 3 }, { visible: 0 }, { requested: 17 }])('rejects absent or partial workloads %j', patch => {
    expect(() => requireWorkload({ ...valid, ...patch })).toThrow();
  });
  it.each([new Map(), new Map([['Browser', 0]]), new Map([['Browser', 0], ['Tab', NaN]])])('rejects missing CPU measurements', samples => {
    expect(() => requireCpuSamples(samples)).toThrow();
  });
});

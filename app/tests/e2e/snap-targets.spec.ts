import { test, expect } from '@playwright/test';
import { SNAP_TARGETS, SNAP_TOLERANCE, findSnapTarget, findSnapOverlaps } from '../../src/snap';

// Pure data checks for the smart-snap target table (no browser needed).
test.describe('snap targets (data)', () => {
  test('exactly the 9 agreed ratios at ±2%, with no overlapping windows', () => {
    expect(SNAP_TARGETS.map((t) => t.id)).toEqual(['1:1', '4:5', '4:3', '3:4', '3:2', '2:3', '16:9', '9:16', '2.39:1']);
    expect(SNAP_TOLERANCE).toBe(0.02);
    expect(findSnapOverlaps(SNAP_TARGETS, SNAP_TOLERANCE)).toEqual([]);
    for (const t of SNAP_TARGETS) expect(t.category, `${t.id} has a category`).toBeTruthy();
  });

  test('resolves near-ratios to the right target and rejects the rest', () => {
    const id = (r: number) => findSnapTarget(r)?.id ?? null;
    expect(id(1.76)).toBe('16:9');
    expect(id(1.7733)).toBe('16:9'); // 4:3 source x 1.33 desqueeze
    expect(id(2.3644)).toBe('2.39:1'); // 16:9 source x 1.33
    expect(id(2.4)).toBe('2.39:1'); // 3:2 x 1.6, 4:3 x 1.8
    expect(id(0.8)).toBe('4:5');
    expect(id(0.745)).toBe('3:4');
    expect(id(0.667)).toBe('2:3');
    expect(id(0.57)).toBe('9:16');
    expect(id(1.019)).toBe('1:1'); // just inside +2%
    expect(id(1.021)).toBeNull(); // just outside
    expect(id(1.2)).toBeNull();
    expect(id(1.995)).toBeNull(); // 3:2 x 1.33 -- not a target
  });
});


// Smart-snap target table. In Free ratio mode, a crop box whose *pixel* aspect
// ratio lands within SNAP_TOLERANCE of a target shows as snapped (green frame,
// label) while dragging, and is set to that exact ratio on release.
//
// Targets are grouped by category so new families can be added without
// touching the matching logic -- e.g. a future "print" category with 6:7 and
// 5:4. Keep findSnapOverlaps() empty when adding targets: with ±2% windows,
// two targets must be more than ~4.1% apart (6:7 vs 4:5 is 7.1%, 5:4 vs 4:3
// is 6.7%, so both would fit).

export type SnapCategory = 'square' | 'social' | 'photo' | 'phone' | 'cinema';

export interface SnapTarget {
  id: string;
  label: string;
  /** width / height, in pixels of the cropped result (so desqueeze is already included). */
  ratio: number;
  category: SnapCategory;
}

export const SNAP_CATEGORIES: Record<SnapCategory, string> = {
  square: 'Square',
  social: 'Social portrait',
  photo: 'Still-photo standards',
  phone: 'Phone video / screen',
  cinema: 'Anamorphic cinema',
};

/** Relative tolerance: |ratio / target - 1| <= 2%. */
export const SNAP_TOLERANCE = 0.02;

export const SNAP_TARGETS: readonly SnapTarget[] = [
  { id: '1:1', label: '1:1 Square', ratio: 1, category: 'square' },
  { id: '4:5', label: '4:5 Vertical IG', ratio: 4 / 5, category: 'social' },
  { id: '4:3', label: '4:3 Classic', ratio: 4 / 3, category: 'photo' },
  { id: '3:4', label: '3:4 Classic', ratio: 3 / 4, category: 'photo' },
  { id: '3:2', label: '3:2 Horizontal', ratio: 3 / 2, category: 'photo' },
  { id: '2:3', label: '2:3 Vertical', ratio: 2 / 3, category: 'photo' },
  { id: '16:9', label: '16:9 Landscape', ratio: 16 / 9, category: 'phone' },
  { id: '9:16', label: '9:16 Vertical', ratio: 9 / 16, category: 'phone' },
  // Scope 2.39:1. Judged on the crop's pixel ratio, so it covers every
  // source x desqueeze combination landing near it (e.g. 16:9 x 1.33 = 2.364,
  // 3:2 x 1.6 = 2.40, 4:3 x 1.8 = 2.40).
  { id: '2.39:1', label: '2.39:1 Cinemascope', ratio: 2.39, category: 'cinema' },
];

const relativeDistance = (a: number, b: number) => Math.abs(a / b - 1);

/** The target closest to pixelRatio within tolerance, or null. */
export function findSnapTarget(pixelRatio: number, targets: readonly SnapTarget[] = SNAP_TARGETS, tolerance = SNAP_TOLERANCE): SnapTarget | null {
  if (!(pixelRatio > 0) || !isFinite(pixelRatio)) return null;
  let best: SnapTarget | null = null;
  let bestD = Infinity;
  for (const t of targets) {
    const d = relativeDistance(pixelRatio, t.ratio);
    if (d <= tolerance + 1e-9 && d < bestD) {
      best = t;
      bestD = d;
    }
  }
  return best;
}

/** Pairs of targets whose ±tolerance windows overlap (should always be empty). */
export function findSnapOverlaps(targets: readonly SnapTarget[], tolerance: number): [string, string][] {
  const sorted = [...targets].sort((a, b) => a.ratio - b.ratio);
  const out: [string, string][] = [];
  for (let i = 0; i < sorted.length; i++) {
    for (let j = i + 1; j < sorted.length; j++) {
      if (sorted[i].ratio * (1 + tolerance) >= sorted[j].ratio * (1 - tolerance)) out.push([sorted[i].id, sorted[j].id]);
    }
  }
  return out;
}

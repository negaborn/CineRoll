// Smart-snap target table. (Stub: API only, no targets yet.)

export type SnapCategory = string;

export interface SnapTarget {
  id: string;
  label: string;
  ratio: number;
  category: SnapCategory;
}

export const SNAP_TOLERANCE = 0;
export const SNAP_TARGETS: readonly SnapTarget[] = [];

export function findSnapTarget(_pixelRatio: number, _targets: readonly SnapTarget[] = SNAP_TARGETS, _tolerance = SNAP_TOLERANCE): SnapTarget | null {
  return null;
}

export function findSnapOverlaps(_targets: readonly SnapTarget[], _tolerance: number): [string, string][] {
  return [];
}

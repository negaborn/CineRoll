export interface EditStateCrop {
  x: number;
  y: number;
  width: number;
  height: number;
}

// Loosely typed on purpose: specs read/write whatever EditState groups they check.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type EditStateForTest = { strategy: string; rotation: { base: number; fine: number }; crop: EditStateCrop; squeeze: number } & Record<string, any>;

export interface CineRollDebug {
  getState(): EditStateForTest;
  setCropForTest(rect: EditStateCrop): void;
  /** Merges a (per-group) partial state, e.g. { frame: { margin: true } }. */
  updateState?(patch: Record<string, unknown>): void;
}

declare global {
  interface Window {
    __CINEROLL_DEBUG__?: CineRollDebug;
  }
}

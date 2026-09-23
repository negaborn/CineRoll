export interface EditStateCrop {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface EditStateForTest {
  strategy: string;
  rotation: { base: number; fine: number };
  crop: EditStateCrop;
}

export interface CineRollDebug {
  getState(): EditStateForTest;
  setCropForTest(rect: EditStateCrop): void;
}

declare global {
  interface Window {
    __CINEROLL_DEBUG__?: CineRollDebug;
  }
}

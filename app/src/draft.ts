// Draft autosave (technical plan v2, P2-4). IndexedDB rather than localStorage:
// the photo itself (a RAW can be 30+ MB) has to be kept, and localStorage is
// small and synchronous. The photo file is stored once per photo under its own
// key; the settings -- which change often -- are stored separately, so an edit
// never rewrites the file. A draft older than 24 hours is not offered.

import { get, set, del } from 'idb-keyval';
import type { EditState } from './state';

const STATE_KEY = 'cineroll-draft';
const FILE_KEY = 'cineroll-draft-file';
const MAX_AGE_MS = 24 * 60 * 60 * 1000;

interface StoredState {
  version: 1;
  timestamp: number;
  fileId: string;
  state: EditState;
  logoUrl: string | null;
}

interface StoredFile {
  fileId: string;
  name: string;
  type: string;
  /** Raw bytes, not a Blob: Safari's private mode refuses Blobs in IndexedDB. */
  bytes: ArrayBuffer;
}

export interface Draft {
  timestamp: number;
  file: File;
  state: EditState;
  logoUrl: string | null;
}

// Storage can be unavailable (private browsing, quota): autosave then quietly does nothing.
const safe = async <T>(f: () => Promise<T>): Promise<T | undefined> => {
  try { return await f(); } catch { return undefined; }
};

/** Stores the photo of the current draft; returns its id. */
export async function saveDraftFile(file: File): Promise<string> {
  const fileId = `${Date.now()}-${file.size}-${file.name}`;
  const bytes = await file.arrayBuffer();
  await safe(() => set(FILE_KEY, { fileId, name: file.name, type: file.type, bytes } satisfies StoredFile));
  return fileId;
}

export async function saveDraftState(fileId: string, state: EditState, logoUrl: string | null): Promise<void> {
  await safe(() => set(STATE_KEY, { version: 1, timestamp: Date.now(), fileId, state, logoUrl } satisfies StoredState));
}

export async function loadDraft(): Promise<Draft | null> {
  const s = await safe(() => get<StoredState>(STATE_KEY));
  if (!s || s.version !== 1 || Date.now() - s.timestamp > MAX_AGE_MS) return null;
  const f = await safe(() => get<StoredFile>(FILE_KEY));
  if (!f || f.fileId !== s.fileId) return null;
  return { timestamp: s.timestamp, file: new File([f.bytes], f.name, { type: f.type }), state: s.state, logoUrl: s.logoUrl };
}

export async function clearDraft(): Promise<void> {
  await safe(() => Promise.all([del(STATE_KEY), del(FILE_KEY)]));
}

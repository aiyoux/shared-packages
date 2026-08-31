/**
 * Shared catalog types. IndexedDB/Dexie is gone — SQLite is the catalog.
 * ROOT_PARENT_KEY remains the in-memory stand-in for a null parent.
 */
export const ROOT_PARENT_KEY = '\u0000root';

export type MetaRow = { key: string; value: unknown };
export type LeaseRow = { key: string; owner: string; expiresAt: number };

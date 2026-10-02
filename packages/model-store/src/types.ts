/** Owning packages declare models; consumers aggregate these definitions. */
/** `optional` files (e.g. one of many voices) never block readiness; a consumer
 * that needs one requires it with `requireFiles`. */
export type ModelFileDef = { path: string; bytes?: number; blake3?: string; url?: string; optional?: boolean };
export type ModelDef = {
  id: string; task: string; label: string; license?: string;
  files: readonly ModelFileDef[];
  origin: { kind: 'hf'; repo: string; revision: string } | { kind: 'url' } | { kind: 'user' };
  builtIn?: string;
};
export type StoredModelFile = {
  bytes: number; blake3: string; source: string; addedAt: number;
  /** Immutable bytes; the manifest swaps its pointer only after close/verification. */
  storagePath: string;
};
export type ModelManifest = { v: 1; modelId: string; revision: string; files: Record<string, StoredModelFile> };
export type ModelFileStatus = ModelFileDef & { state: 'present' | 'missing' | 'size-mismatch' | 'hash-mismatch'; actual?: StoredModelFile };
export type ModelStatus = { files: ModelFileStatus[]; present: number; total: number; bytes: number; ready: boolean; revision: string };
export type ModelWriteOptions = {
  expectedBytes?: number; expectedBlake3?: string; source?: string;
  signal?: AbortSignal; onProgress?: (bytes: number) => void;
};

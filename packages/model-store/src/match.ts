import type { ModelDef, ModelFileDef } from './types.js';

export type ModelSourceFile = {
  path: string; bytes: number;
  open: (signal: AbortSignal) => Promise<ReadableStream<Uint8Array>>;
};
/** `hash-mismatch`: the source holds a different file under this path (another
 *  version); `present`: already stored with the expected size and hash, so not loaded
 *  again; `not-fetchable`: the source cannot provide this file (a host the
 *  chosen monitor will not retrieve). */
export type ModelFileMatch = {
  file: ModelFileDef; source?: ModelSourceFile;
  state: 'found' | 'missing' | 'ambiguous' | 'size-mismatch' | 'hash-mismatch' | 'present' | 'not-fetchable';
};
/** Relative paths win. Basenames are safe only when unique on both sides. */
export function matchModelFiles(def: ModelDef, sources: readonly ModelSourceFile[]): ModelFileMatch[] {
  const base = (path: string) => path.split('/').at(-1)!;
  return def.files.map(file => {
    const exact = sources.filter(source => source.path === file.path || source.path.endsWith('/' + file.path));
    const candidates = exact.length ? exact : def.files.filter(other => base(other.path) === base(file.path)).length === 1
      ? sources.filter(source => base(source.path) === base(file.path)) : [];
    if (candidates.length > 1) return { file, state: 'ambiguous' };
    const source = candidates[0];
    if (!source) return { file, state: 'missing' };
    return { file, source, state: file.bytes != null && source.bytes !== file.bytes ? 'size-mismatch' : 'found' };
  });
}
export function deviceModelFiles(files: readonly File[]): ModelSourceFile[] {
  return files.map(file => ({ path: file.webkitRelativePath || file.name, bytes: file.size,
    async open(signal) { signal.throwIfAborted(); return file.stream(); } }));
}
/** Leave files the store already holds intact out of a load (Replace is per file). */
export function skipStored(matches: readonly ModelFileMatch[], status: { files: readonly { path: string; state: string }[] }): ModelFileMatch[] {
  const stored = new Set(status.files.filter(file => file.state === 'present').map(file => file.path));
  return matches.map(row => stored.has(row.file.path) && row.state === 'found' ? { file: row.file, state: 'present' } : row);
}

import type { ModelDef, ModelFileDef } from './types.js';

export type ModelSourceFile = {
  path: string; bytes: number;
  open: (signal: AbortSignal) => Promise<ReadableStream<Uint8Array>>;
};
export type ModelFileMatch = {
  file: ModelFileDef; source?: ModelSourceFile;
  state: 'found' | 'missing' | 'ambiguous' | 'size-mismatch';
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

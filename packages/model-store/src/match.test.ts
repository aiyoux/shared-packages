import { describe, expect, it } from 'vitest';
import { matchModelFiles, skipStored } from './match.js';
import type { ModelDef } from './types.js';
const def: ModelDef = { id: 'test', label: 'Test', task: 'image', origin: { kind: 'user' }, files: [
  { path: 'text_encoder/model.onnx', bytes: 3 }, { path: 'unet/model.onnx', bytes: 4 }, { path: 'tokenizer.json', bytes: 2 }
] };
const source = (path: string, bytes: number) => ({ path, bytes, open: async () => new Blob([]).stream() });
describe('model file preview matching', () => {
  it('preserves duplicate basenames using relative paths beneath a picked folder', () => {
    expect(matchModelFiles(def, [source('folder/text_encoder/model.onnx', 3), source('folder/unet/model.onnx', 4), source('tokenizer.json', 2)]).map(row => row.state)).toEqual(['found', 'found', 'found']);
  });
  it('does not reuse an ambiguous mobile basename for two required files', () => {
    expect(matchModelFiles(def, [source('model.onnx', 3)]).map(row => row.state)).toEqual(['missing', 'missing', 'missing']);
  });
  it('shows duplicate picks, wrong sizes and missing files before a write', () => {
    const preview = matchModelFiles(def, [source('a/text_encoder/model.onnx', 3), source('b/text_encoder/model.onnx', 3), source('unet/model.onnx', 3)]);
    expect(preview.map(row => row.state)).toEqual(['ambiguous', 'size-mismatch', 'missing']);
  });
});
describe('skipStored', () => {
  it('leaves already-stored files out of a load but keeps the rest', () => {
    const rows = matchModelFiles(def, [{ path: 'tokenizer.json', bytes: 2, open: async () => new Blob(['{}']).stream() }, { path: 'unet/model.onnx', bytes: 4, open: async () => new Blob(['abcd']).stream() }]);
    const status = { files: [{ path: 'tokenizer.json', state: 'present' }, { path: 'unet/model.onnx', state: 'hash-mismatch' }] };
    expect(skipStored(rows, status).map(row => [row.file.path, row.state])).toEqual([
      ['text_encoder/model.onnx', 'missing'], ['unet/model.onnx', 'found'], ['tokenizer.json', 'present']
    ]);
  });
});

import { describe, expect, it } from 'vitest';
import { generateBarcode } from './generate.js';

describe('linear generate', () => {
  it('rejects non-numeric EAN/UPC payloads before loading the writer', async () => {
    expect(await generateBarcode('oats', 'ean13')).toBeNull();
    expect(await generateBarcode('', 'upca')).toBeNull();
  });
});

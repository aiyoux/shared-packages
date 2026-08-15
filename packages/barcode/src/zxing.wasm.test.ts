import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { ZXING_READER_WASM_URL, ZXING_WRITER_WASM_URL } from './index.js';

/**
 * The zxing `.wasm` binaries are vendored beside this package so no app fetches
 * executable code from a CDN at runtime (and so a same-origin CSP can hold).
 * Nothing else notices if they drift out of sync with the installed package —
 * barcode scanning would just silently break or, worse, run a mismatched
 * build — so pin them here.
 *
 * On failure: re-copy both files from node_modules/zxing-wasm/dist/** into
 * src/wasm/.
 */
const here = dirname(fileURLToPath(import.meta.url));
const vendorDir = join(here, 'wasm');
const require = createRequire(import.meta.url);

function installedWasm(kind: 'writer' | 'reader'): string {
  return require.resolve(`zxing-wasm/${kind}/zxing_${kind}.wasm`);
}

async function sha256(path: string): Promise<string> {
  return createHash('sha256').update(await readFile(path)).digest('hex');
}

describe('vendored zxing wasm', () => {
  it('writer binary matches the installed package', async () => {
    const installed = installedWasm('writer');
    expect(existsSync(installed), `zxing-wasm writer missing at ${installed}`).toBe(true);
    const vendored = await sha256(join(vendorDir, 'zxing_writer.wasm'));
    expect(vendored, 're-copy src/wasm/zxing_writer.wasm from node_modules').toBe(
      await sha256(installed)
    );
  });

  it('reader binary matches the installed package', async () => {
    const installed = installedWasm('reader');
    expect(existsSync(installed), `zxing-wasm reader missing at ${installed}`).toBe(true);
    const vendored = await sha256(join(vendorDir, 'zxing_reader.wasm'));
    expect(vendored, 're-copy src/wasm/zxing_reader.wasm from node_modules').toBe(
      await sha256(installed)
    );
  });

  it('resolves to a same-origin URL rather than a CDN', () => {
    for (const url of [ZXING_WRITER_WASM_URL, ZXING_READER_WASM_URL]) {
      expect(url).toBeTypeOf('string');
      expect(url).not.toMatch(/^https?:\/\//);
      expect(url).toMatch(/zxing_(writer|reader)/);
    }
  });
});

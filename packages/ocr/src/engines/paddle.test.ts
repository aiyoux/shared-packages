import { load as loadYaml } from 'js-yaml';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PPOCR_JPN_MODEL } from '../models.ts';
import { PADDLE_DET_MODEL, PADDLE_REC_MODEL, PPOCR_JPN_REC_MODEL, japanRecConfigText, stagePaddleArchives, tarOf } from './paddle.ts';

/** Entries the store must hand back for any readReady snapshot: fake bytes,
 * plus a dict the rec-staging test asserts on. */
const JPN_DICT = 'あ\nい\n"\n#\n-\nき\n';

const store = vi.hoisted(() => ({
	readReady: vi.fn(async (_def: unknown, cb: (files: { file: (name: string) => Promise<Blob> }) => unknown) =>
		cb({
			file: (name: string) =>
				Promise.resolve(name.endsWith('.txt') ? new Blob([JPN_DICT]) : new Blob([new Uint8Array([1, 2, 3])]))
		})
	)
}));
vi.mock('@shared-packages/model-store', () => ({ browserModelStore: store }));

// paddleocr-js pulls in opencv-js at module scope — never load it here. The
// sdk mock records what the pipeline create call would receive.
const paddleSdk = vi.hoisted(() => ({ create: vi.fn(async () => ({ predict: vi.fn() })) }));
vi.mock('@paddleocr/paddleocr-js', () => ({ PaddleOCR: paddleSdk }));

/** js-yaml is the yaml loader paddleocr-js bundles, so loading the
 * synthesized config with it is the real round-trip. */
type ParsedRecConfig = {
	Global?: { model_name?: string };
	PreProcess?: { transform_ops?: Array<{ RecResizeImg?: { image_shape?: number[] } }> };
	PostProcess?: { character_dict?: string[] };
};

function parseYml(text: string): ParsedRecConfig {
	return loadYaml(text) as ParsedRecConfig;
}

describe('tarOf', () => {
	it('layouts ustar blocks with checksums, exactly one tail block', () => {
		const tar = tarOf([
			{ name: 'inference.onnx', bytes: new Uint8Array(600) },
			{ name: 'inference.yml', bytes: new Uint8Array(10) }
		]);
		expect(tar.length).toEqual(512 + 1024 + 512 + 512 + 1024);
		const decode = (start: number, len: number) => new TextDecoder().decode(tar.subarray(start, start + len));
		expect(decode(0, 15)).toBe('inference.onnx\0');
		expect(decode(124, 12)).toBe('00000001130\0'); // 600 → octal 1130, NUL-terminated
		expect(decode(1536, 14)).toBe('inference.yml\0'); // second header sits after entry 1's padded content
		// tarOf sums the header with the checksum field blanked to spaces.
		const header1 = new Uint8Array(tar.subarray(0, 512));
		header1.fill(0x20, 148, 156);
		const checksum = header1.reduce((n, b) => n + b, 0);
		expect(parseInt(decode(148, 6), 8)).toBe(checksum);
	});
});

describe('stagePaddleArchives', () => {
	beforeEach(() => {
		store.readReady.mockClear();
		paddleSdk.create.mockClear();
	});

	it('packs the v5 det and rec stages behind their catalog stage keys', async () => {
		const archives = await stagePaddleArchives('eng');
		expect([...archives.keys()]).toEqual([`browser-models:${PADDLE_DET_MODEL}`, `browser-models:${PADDLE_REC_MODEL}`]);
		const det = new TextDecoder().decode(archives.get(`browser-models:${PADDLE_DET_MODEL}`)!);
		expect(det.startsWith('inference.onnx')).toBe(true);
	});

	it('swaps the rec slot for the synthesized Japan pack without touching det', async () => {
		const archives = await stagePaddleArchives('jpn');
		expect([...archives.keys()]).toEqual([`browser-models:${PADDLE_DET_MODEL}`, `browser-models:${PPOCR_JPN_REC_MODEL}`]);
		const raw = archives.get(`browser-models:${PPOCR_JPN_REC_MODEL}`)!;
		const text = new TextDecoder().decode(raw);
		expect(text.includes('inference.onnx')).toBe(true);
		const ymlIndex = text.indexOf('Global:');
		const yml = text.slice(ymlIndex, text.indexOf('\0', ymlIndex));
		// model_name must equal the requested rec name (paddleocr-js validates
		// one against the other), the rec shape matches PP-OCRv5's own yml, and
		// the quoted dict round-trips specials intact.
		const parsed = parseYml(yml);
		expect(parsed.Global?.model_name).toBe(PPOCR_JPN_REC_MODEL);
		expect(parsed.PreProcess?.transform_ops?.[0]?.RecResizeImg?.image_shape).toEqual([3, 48, 320]);
		expect(parsed.PostProcess?.character_dict).toEqual(JPN_DICT.split('\n').filter((c) => c.length > 0));
		expect(parsed.PostProcess?.character_dict).toContain('"');
	});

	it('rejects an empty dict outright', () => {
		expect(() => japanRecConfigText('\n\r\n')).toThrow(/dict is empty/);
	});
});
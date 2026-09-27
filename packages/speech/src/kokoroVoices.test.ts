import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';
import { KOKORO_VOICES, kokoroVoiceDef } from './models.js';

// kokoro-js keeps its voice table internal (only a loaded instance exposes
// it), so read the ids and grades out of the shipped bundle: a library bump
// that adds, drops or regrades a voice fails here instead of in the picker.
function libraryVoices(): Map<string, string> {
	const bundle = readFileSync(createRequire(import.meta.url).resolve('kokoro-js'), 'utf8');
	const voices = new Map<string, string>();
	for (const m of bundle.matchAll(/\b([a-z]{2}_[a-z]+):\{name:"[^"]+".*?overallGrade:"([^"]+)"\}/g)) {
		voices.set(m[1]!, m[2]!);
	}
	return voices;
}

describe('kokoro voice catalog', () => {
	it('lists exactly the voices kokoro-js accepts, with its grades', () => {
		const lib = libraryVoices();
		expect(lib.size).toBeGreaterThan(0);
		expect(new Map(KOKORO_VOICES.map((v) => [v.id, v.grade]))).toEqual(lib);
	});

	it('names each voice bin after its id and groups by accent', () => {
		for (const v of KOKORO_VOICES) {
			expect(v.bin).toBe(`voices/${v.id}.bin`);
			expect(v.group).toBe(v.id.startsWith('a') ? 'American English' : 'British English');
		}
	});

	it('falls back to the first voice for a foreign or empty voice id', () => {
		const first = KOKORO_VOICES[0]!.bin;
		for (const voice of ['', 'Microsoft George', 'en_US-amy-medium']) {
			expect(kokoroVoiceDef(voice).files.at(-1)!.path).toBe(first);
		}
		expect(kokoroVoiceDef('bm_george').files.at(-1)!.path).toBe('voices/bm_george.bin');
	});
});

import { describe, expect, it } from 'vitest';
import {
	DEFAULT_PIPER_VOICE,
	piperConfigPath,
	piperFileUrl,
	piperVoice,
	piperVoiceModel,
	piperVoiceIds,
	piperVoiceList,
	PIPER_HF_REVISION,
	PIPER_VOICES
} from './piperVoices.js';

describe('piper voice catalog', () => {
	it('is non-empty with unique ids', () => {
		const ids = piperVoiceIds();
		expect(ids.length).toBeGreaterThan(100);
		expect(new Set(ids).size).toBe(ids.length);
	});

	it('every id parses and has a well-formed repo path', () => {
		for (const id of piperVoiceIds()) {
			const voice = piperVoice(id);
			expect(voice.path).toMatch(/^[a-z]{2}\/[a-z]{2}_[A-Z]{2}\/[\wà-ÿ-]+\/(x_low|low|medium|high)\/[\wà-ÿ-]+\.onnx$/u);
			expect(piperConfigPath(voice)).toBe(voice.path + '.json');
		}
	});

	it('labels carry the language and quality', () => {
		const voice = piperVoice('en_US-amy-medium');
		expect(voice.label).toContain('Amy');
		expect(voice.label).toContain('English (US)');
		expect(voice.label).toContain('medium');
	});

	it('orders the picker with en_US first', () => {
		const list = piperVoiceList();
		expect(list[0]?.language).toBe('en_US');
	});

	it('builds HF download URLs from the piper-voices repo', () => {
		const voice = piperVoice('en_US-amy-medium');
		expect(piperFileUrl(voice.path)).toBe(
			`https://huggingface.co/diffusionstudio/piper-voices/resolve/${PIPER_HF_REVISION}/en/en_US/amy/medium/en_US-amy-medium.onnx`
		);
	});

	it('store models cover both voice files with pinned hashes', () => {
		const def = piperVoiceModel(DEFAULT_PIPER_VOICE);
		expect(def.id).toBe(`speech:piper-${DEFAULT_PIPER_VOICE}`);
		expect(def.origin).toEqual({ kind: 'hf', repo: 'diffusionstudio/piper-voices', revision: PIPER_HF_REVISION });
		expect(def.files.map((f) => f.path).sort()).toEqual(
			[
				'en/en_US/amy/medium/en_US-amy-medium.onnx',
				'en/en_US/amy/medium/en_US-amy-medium.onnx.json'
			].sort()
		);
		for (const voice of PIPER_VOICES) {
			for (const file of piperVoiceModel(voice.id).files) {
				expect(file.bytes).toBeGreaterThan(0);
				expect(file.blake3).toMatch(/^[a-f0-9]{64}$/);
			}
		}
	});

	it('throws on unknown voices', () => {
		expect(() => piperVoice('nope')).toThrow();
	});
});
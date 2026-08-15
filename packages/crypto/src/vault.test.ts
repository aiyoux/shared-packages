import { describe, expect, it } from 'vitest';
import { TEST_PBKDF2_ITERATIONS } from './engines/webcrypto.js';
import { sodiumTestKdf } from './engines/libsodium.js';
import { loadEngine } from './engines.js';
import {
	isVaultBytes,
	isVaultName,
	openVault,
	parseVaultHeader,
	sealVault,
	suggestVaultName
} from './vault.js';

const NOTE = new TextEncoder().encode('scratch-pad vault fixture\n');
const PASS = 'correct horse battery staple';

describe('detect', () => {
	it('rejects random bytes and accepts the magic', () => {
		expect(isVaultBytes(NOTE)).toBe(false);
		expect(isVaultName('secret.txt.spvault')).toBe(true);
		expect(isVaultName('secret.txt')).toBe(false);
		expect(suggestVaultName([{ path: 'docs/readme.md', data: NOTE }])).toBe('readme.md.spvault');
	});
});

describe('webcrypto vault', () => {
	it('round-trips a single file', async () => {
		const sealed = await sealVault(
			'webcrypto',
			[{ path: 'note.txt', data: NOTE }],
			PASS,
			{ kdf: { cost: TEST_PBKDF2_ITERATIONS } }
		);
		expect(sealed.kind).toBe('single');
		expect(isVaultBytes(sealed.data)).toBe(true);
		expect(parseVaultHeader(sealed.data).engine).toBe('webcrypto');
		const opened = await openVault(sealed.data, PASS);
		expect(opened.entries).toHaveLength(1);
		expect(opened.entries[0]!.path).toBe('note.txt');
		expect(new TextDecoder().decode(opened.entries[0]!.data)).toBe(new TextDecoder().decode(NOTE));
	});

	it('round-trips a tree of files', async () => {
		const sealed = await sealVault(
			'webcrypto',
			[
				{ path: 'a.txt', data: NOTE },
				{ path: 'nested/b.txt', data: new TextEncoder().encode('inner') }
			],
			PASS,
			{ kind: 'tree', kdf: { cost: TEST_PBKDF2_ITERATIONS } }
		);
		expect(sealed.kind).toBe('tree');
		const opened = await openVault(sealed.data, PASS);
		expect(opened.entries.map((e) => e.path).sort()).toEqual(['a.txt', 'nested/b.txt']);
		expect(new TextDecoder().decode(opened.entries.find((e) => e.path === 'nested/b.txt')!.data)).toBe(
			'inner'
		);
	});

	it('rejects a wrong password', async () => {
		const sealed = await sealVault(
			'webcrypto',
			[{ path: 'n.txt', data: NOTE }],
			PASS,
			{ kdf: { cost: TEST_PBKDF2_ITERATIONS } }
		);
		await expect(openVault(sealed.data, 'wrong')).rejects.toThrow(/wrong password|failed/i);
	});

	it('rejects path traversal', async () => {
		await expect(
			sealVault('webcrypto', [{ path: '../escape', data: NOTE }], PASS, {
				kdf: { cost: TEST_PBKDF2_ITERATIONS }
			})
		).rejects.toThrow(/Unsafe/);
	});
});

describe('libsodium vault', () => {
	it('round-trips a single file with Argon2id', async () => {
		await loadEngine('libsodium');
		const sealed = await sealVault(
			'libsodium',
			[{ path: 'note.txt', data: NOTE }],
			PASS,
			{ kdf: await sodiumTestKdf() }
		);
		expect(parseVaultHeader(sealed.data).engine).toBe('libsodium');
		const opened = await openVault(sealed.data, PASS);
		expect(new TextDecoder().decode(opened.entries[0]!.data)).toBe(new TextDecoder().decode(NOTE));
	});
});

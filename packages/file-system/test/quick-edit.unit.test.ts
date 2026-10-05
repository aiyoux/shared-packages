import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { canSaveQuickEdit, quickEditContext } from '../src/ui/quickEdit.ts';
import type { ExplorerDriver, ExplorerEntry } from '../src/ui/explorerDriver.ts';

const entry: ExplorerEntry = { id: 'photo', kind: 'file', name: 'photo.png', parentId: 'source-folder' };

describe('quick-edit connection contract', () => {
	for (const [id, method] of [['local', 'writeFile'], ['memory', 'writeFile'], ['disk', 'writeFile'], ['monitor', 'upload'], ['b2', 'upload'], ['peer-fs', 'writeFile']] as const) {
		it(`reads and saves on ${id} using ${method}`, async () => {
			const calls: unknown[][] = [];
			const driver = {
				id,
				async readBlob(this: ExplorerDriver, id: string) { assert.equal(this.id, driver.id); calls.push(['read', id]); return new Blob(['source']); },
				async [method](this: ExplorerDriver, parentId: string | null, file: File) {
					assert.equal(this.id, driver.id);
					calls.push(['save', parentId, file.name]);
					return { ...entry, name: file.name };
				}
			} as unknown as ExplorerDriver;
			assert.equal(canSaveQuickEdit(driver), true);
			const context = quickEditContext(driver, entry);
			assert.equal(await (await context.read()).text(), 'source');
			const saved = await context.save(new File(['edited'], 'photo (edit).png'));
			assert.equal(saved.name, 'photo (edit).png');
			assert.deepEqual(calls, [['read', 'photo'], ['save', 'source-folder', 'photo (edit).png']]);
			assert.equal(context.sourceFileId, id === 'local' ? entry.id : id === 'memory' ? 'memory:photo' : undefined);
		});
	}

	it('keeps the original folder when the row changes during editing', async () => {
		const row = { ...entry };
		let parent: string | null = null;
		const driver = { id: 'monitor', upload: async (id: string | null) => { parent = id; return entry; } } as unknown as ExplorerDriver;
		const context = quickEditContext(driver, row);
		row.parentId = 'another-folder';
		await context.save(new File([], 'out.png'));
		assert.equal(parent, 'source-folder');
	});

	it('uses the local write contract even when upload chrome is disabled', async () => {
		const writes: string[] = [];
		const driver = { id: 'local', capabilities: { supportsUpload: false },
			writeFile: async (_parent: string | null, file: File) => { writes.push(file.name); return entry; },
			upload: async () => { throw new Error('upload must not be used'); }
		} as unknown as ExplorerDriver;
		await quickEditContext(driver, entry).save(new File([], 'copy.png'));
		assert.deepEqual(writes, ['copy.png']);
	});

	it('reports a read-only connection without claiming an editor source binding', async () => {
		const driver = { id: 'peer-fs' } as ExplorerDriver;
		assert.equal(canSaveQuickEdit(driver), false);
		const context = quickEditContext(driver, entry);
		assert.equal(context.sourceFileId, undefined);
		await assert.rejects(context.save(new File([], 'copy.png')), /cannot save edited files/);
	});
});

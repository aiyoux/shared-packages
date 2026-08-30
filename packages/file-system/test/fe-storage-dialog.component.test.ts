import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/svelte';
import FeStorageDialog from '../src/ui/FeStorageDialog.svelte';
import { createVfs, createMemoryOpfs, resetSharedVfsForTests } from '../src/index.ts';
import type { OpfsBlobStore } from '../src/opfs.ts';

function rangeStore(): OpfsBlobStore {
	const base = createMemoryOpfs();
	return {
		...base,
		async readRange(path, offset, length, contentType) {
			const all = await base.read(path);
			return new Blob([all.subarray(offset, offset + length) as BlobPart], {
				type: contentType ?? 'application/octet-stream'
			});
		}
	};
}

async function seeded() {
	resetSharedVfsForTests();
	const vfs = createVfs({
		dbName: `fsdlg-${Date.now()}-${Math.random()}`,
		opfs: rangeStore(),
		requestPersist: false
	});
	await vfs.ready();
	const folder = await vfs.mkdir(null, 'stuff');
	await vfs.writeFiles(
		Array.from({ length: 8 }, (_, i) => ({
			parentId: folder.id,
			name: `f-${i}.bin`,
			body: new Uint8Array(1024).fill(i)
		})),
		{ pack: true }
	);
	return vfs;
}

describe('FeStorageDialog reclaim', () => {
	it('sweeps the orphaned packs the check reports, and says so', async () => {
		const vfs = await seeded();
		// Debris of the kind a crashed pack write leaves: a pack file no
		// blobRef names. It is what "orphan-pack" means, and the only pack
		// state that is actually reclaimable.
		await vfs.opfs.writeFinal('packs/stray.bin', new Uint8Array(64));

		render(FeStorageDialog, { props: { vfs, onClose: vi.fn() } });

		await fireEvent.click(await screen.findByTestId('fe-storage-check'));
		await waitFor(() =>
			expect(screen.getByTestId('fe-storage-issues').textContent).toMatch(/orphan-pack/)
		);
		// The report must point at the way out, since deleting files cannot help.
		expect(screen.getByTestId('fe-storage-orphan-hint')).toBeTruthy();

		await fireEvent.click(screen.getByTestId('fe-storage-reclaim'));
		await waitFor(() =>
			expect(screen.getByTestId('fe-storage-reclaimed').textContent).toMatch(/Reclaimed 1 unused/)
		);
		// Re-checked automatically: a stale problem list would be its own lie.
		await waitFor(() =>
			expect(screen.getByTestId('fe-storage-verdict').textContent).toMatch(/integrity verified/)
		);
		expect(await vfs.opfs.exists('packs/stray.bin')).toBe(false);
		await vfs.db.delete();
	});

	it('says so plainly when there is nothing to reclaim', async () => {
		const vfs = await seeded();
		render(FeStorageDialog, { props: { vfs, onClose: vi.fn() } });
		await fireEvent.click(await screen.findByTestId('fe-storage-reclaim'));
		await waitFor(() =>
			expect(screen.getByTestId('fe-storage-reclaimed').textContent).toMatch(/Nothing to reclaim/)
		);
		await vfs.db.delete();
	});

	it('is not offered in project scope, where a global sweep would misread', async () => {
		const vfs = await seeded();
		const root = (await vfs.list({ parentId: null }))[0]!;
		render(FeStorageDialog, { props: { vfs, scope: 'project', rootId: root.id, onClose: vi.fn() } });
		await screen.findByTestId('fe-storage-check');
		expect(screen.queryByTestId('fe-storage-reclaim')).toBeNull();
		await vfs.db.delete();
	});
});

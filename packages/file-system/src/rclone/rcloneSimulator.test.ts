import { describe, it, expect, beforeEach } from 'vitest';
import { RcloneSimulator } from './rcloneSimulator.js';

describe('RcloneSimulator', () => {
	let sim: RcloneSimulator;

	beforeEach(() => {
		sim = new RcloneSimulator();
	});

	it('list/mkdir/deletefile/upload/stat seed tree', async () => {
		const t = sim.transport();
		await t.call('operations/mkdir', { fs: 'sim:', remote: 'docs/' });
		await t.upload({
			fs: 'sim:',
			remote: 'docs/a.txt',
			body: new TextEncoder().encode('hi')
		});
		const listed = await t.call('operations/list', { fs: 'sim:', remote: 'docs/' });
		const list = listed.list as Array<{ Name: string; IsDir: boolean }>;
		expect(list.some((i) => i.Name === 'a.txt' && !i.IsDir)).toBe(true);

		const st = await t.call('operations/stat', { fs: 'sim:', remote: 'docs/a.txt' });
		expect((st.item as { Size: number }).Size).toBe(2);

		await t.call('operations/deletefile', { fs: 'sim:', remote: 'docs/a.txt' });
		const after = await t.call('operations/list', { fs: 'sim:', remote: 'docs/' });
		expect((after.list as unknown[]).length).toBe(0);
	});

	it('movefile and copyfile', async () => {
		const t = sim.transport();
		sim.seedFile('a.txt', 'one');
		await t.call('operations/movefile', {
			srcFs: 'sim:',
			srcRemote: 'a.txt',
			dstFs: 'sim:',
			dstRemote: 'b.txt'
		});
		await t.call('operations/copyfile', {
			srcFs: 'sim:',
			srcRemote: 'b.txt',
			dstFs: 'sim:',
			dstRemote: 'c.txt'
		});
		const root = await t.call('operations/list', { fs: 'sim:', remote: '' });
		const names = ((root.list as Array<{ Name: string }>) ?? []).map((i) => i.Name).sort();
		expect(names).toEqual(['b.txt', 'c.txt']);
	});

	it('purge removes tree', async () => {
		const t = sim.transport();
		sim.seedDir('docs/');
		sim.seedFile('docs/a.txt', 'x');
		await t.call('operations/purge', { fs: 'sim:', remote: 'docs/' });
		const root = await t.call('operations/list', { fs: 'sim:', remote: '' });
		expect((root.list as unknown[]).length).toBe(0);
	});

	it('unauthorized when authorized=false', async () => {
		sim.authorized = false;
		const t = sim.transport();
		await expect(t.call('rc/noopauth', {})).rejects.toMatchObject({ status: 401 });
	});
});

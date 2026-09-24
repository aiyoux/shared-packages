import assert from 'node:assert/strict';
import { test } from 'node:test';
import { engineFromBroadcast } from '../src/catalogEngine.ts';

const CHANNEL = 'vfs-catalog-sql';

test('a follower stops waiting when the catalog leader is gone', async () => {
	const eng = engineFromBroadcast('follower-gone');
	const started = Date.now();
	await assert.rejects(() => eng.exec('SELECT 1 AS ok'), /catalog leader unreachable/);
	const waited = Date.now() - started;
	assert.ok(waited < 10_000, `waited ${waited}ms for a dead leader`);
	await eng.close();
});

test('a follower uses a leader that answers', async () => {
	const leader = new BroadcastChannel(CHANNEL);
	leader.onmessage = (ev: MessageEvent) => {
		const data = ev.data as { type?: string; id?: number; session?: string };
		if (data?.type === 'who') {
			leader.postMessage({ type: 'ready' });
			return;
		}
		if (data?.type === 'sql' && typeof data.id === 'number') {
			leader.postMessage({
				type: 'sql-res',
				id: data.id,
				session: data.session,
				ok: true,
				rows: [{ ok: 1 }]
			});
		}
	};
	const eng = engineFromBroadcast('follower-live');
	try {
		const rows = await eng.exec('SELECT 1 AS ok');
		assert.deepEqual(rows, [{ ok: 1 }]);
	} finally {
		await eng.close();
		leader.close();
	}
});

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { SqliteCatalog } from '../src/catalog.ts';
import { CATALOG_LEADER_CHANGED, type SqlEngine } from '../src/catalogEngine.ts';

/** An engine whose calls all hang, then die together the way a lost leader's do. */
function dyingEngine(): { engine: SqlEngine; die: () => void } {
	const waiting: Array<(e: Error) => void> = [];
	const hang = () =>
		new Promise<never>((_, reject) => {
			waiting.push(reject);
		});
	const engine: SqlEngine = {
		exec: hang,
		run: hang,
		runMany: hang,
		begin: hang,
		commit: hang,
		rollback: hang,
		wipe: hang,
		close: async () => {}
	};
	const die = () => {
		for (const reject of waiting.splice(0)) reject(new Error(CATALOG_LEADER_CHANGED));
	};
	return { engine, die };
}

test('calls in flight when the catalog dies all ride the one recovery', async () => {
	const cat = new SqliteCatalog(`recovery-${Date.now()}`);
	const { engine, die } = dyingEngine();
	(cat as unknown as { engine: SqlEngine }).engine = engine;

	const calls = [
		cat.exec('SELECT 1 AS ok'),
		cat.exec('SELECT 2 AS ok'),
		cat.exec('SELECT 3 AS ok')
	];
	await new Promise((r) => setTimeout(r, 0));
	die();

	const rows = await Promise.all(calls);
	assert.deepEqual(rows, [[{ ok: 1 }], [{ ok: 2 }], [{ ok: 3 }]]);
	cat.close();
});

test('a call made while the catalog is recovering waits for it', async () => {
	const cat = new SqliteCatalog(`recovery-late-${Date.now()}`);
	const { engine, die } = dyingEngine();
	(cat as unknown as { engine: SqlEngine }).engine = engine;

	const first = cat.exec('SELECT 1 AS ok');
	await new Promise((r) => setTimeout(r, 0));
	die();
	// Recovery is under way and the old engine is gone.
	await new Promise((r) => setTimeout(r, 0));
	const late = cat.exec('SELECT 2 AS ok');

	assert.deepEqual(await first, [{ ok: 1 }]);
	assert.deepEqual(await late, [{ ok: 2 }]);
	cat.close();
});

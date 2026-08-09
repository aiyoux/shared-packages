import type { MigrationContext, MigrationReport, MigrationStep } from '../types.js';
import type { VfsService } from '../vfs.js';
import { VfsError } from '../types.js';

export async function runMigrations(
	vfs: VfsService,
	steps: MigrationStep[],
	opts?: { force?: boolean }
): Promise<MigrationReport> {
	await vfs.ready();
	const report: MigrationReport = { steps: [] };

	for (const step of steps) {
		const flagKey = `migrated:${step.id}`;
		const existing = await vfs.getMeta<{ status: string }>(flagKey);
		if (existing?.status === 'complete' && !opts?.force) {
			report.steps.push({ id: step.id, status: 'skipped' });
			continue;
		}

		const leaseKey = `migrating:${step.id}`;
		const owner = `mig_${Date.now()}`;
		const now = Date.now();
		// simple lease
		await vfs.db.leases.put({ key: leaseKey, owner, expiresAt: now + 120_000 });
		await vfs.setMeta(flagKey, { status: 'in_progress', at: now, leaseOwner: owner });

		const ctx: MigrationContext = { vfs, force: opts?.force };
		try {
			const result = await step.run(ctx);
			await vfs.setMeta(flagKey, {
				status: 'complete',
				at: Date.now(),
				counts: { migrated: result.migrated, skipped: result.skipped }
			});
			await vfs.db.leases.delete(leaseKey);
			report.steps.push({ id: step.id, status: 'complete', result });
		} catch (e) {
			const msg = e instanceof Error ? e.message : String(e);
			await vfs.setMeta(flagKey, { status: 'failed', at: Date.now(), error: msg });
			await vfs.db.leases.delete(leaseKey);
			report.steps.push({ id: step.id, status: 'failed', error: msg });
			if (e instanceof VfsError && e.code === 'MIGRATION_IN_PROGRESS') throw e;
		}
	}

	return report;
}

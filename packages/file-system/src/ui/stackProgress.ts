import type {
	TransferDirection,
	TransferIntegrity,
	TransferItem,
	TransferStatus
} from '../transferRegistry.js';

/** One UI row: first-leg (download) can lead; second-leg (wire/upload) is never ahead. */
export type StackedProgress = {
	id: string;
	ids: string[];
	name: string;
	size: number;
	/** Leading leg — download / receive (semi-transparent fill). */
	ahead: number;
	/** Trailing leg — send / dest write (solid fill). */
	behind: number;
	done: boolean;
	status: TransferStatus;
	direction: TransferDirection;
	error?: string;
	sha256?: string;
	integrity?: TransferIntegrity;
	resumed?: boolean;
	parallelStreams?: number;
};

function displayName(wire?: TransferItem, remote?: TransferItem): string {
	const raw = wire?.name || remote?.name || 'File';
	const cut = raw.split(' · ')[0]?.trim();
	return cut || raw;
}

function itemStatus(items: TransferItem[]): TransferStatus {
	if (items.some((t) => t.status === 'failed')) return 'failed';
	if (items.length > 0 && items.every((t) => t.done || t.status === 'done')) return 'done';
	if (items.some((t) => t.status === 'hashing')) return 'hashing';
	if (items.some((t) => t.status === 'incomplete')) return 'incomplete';
	return 'active';
}

/**
 * Pair `${opId}:remote` + `${opId}:wire` into one stacked bar.
 * Unpaired copy/send rows stay single-fill (ahead === behind).
 */
export function stackTransferItems(items: TransferItem[]): StackedProgress[] {
	const groups = new Map<string, { remote?: TransferItem; wire?: TransferItem }>();
	const singles: TransferItem[] = [];

	for (const t of items) {
		const m = /^(.*):(remote|wire)$/.exec(t.id);
		if (!m) {
			singles.push(t);
			continue;
		}
		const key = m[1]!;
		const leg = m[2] as 'remote' | 'wire';
		const g = groups.get(key) ?? {};
		g[leg] = t;
		groups.set(key, g);
	}

	const out: StackedProgress[] = [];
	for (const [opId, g] of groups) {
		const parts = [g.remote, g.wire].filter((x): x is TransferItem => !!x);
		const size = Math.max(0, ...parts.map((p) => p.size || 0));
		const remoteN = g.remote?.transferred ?? 0;
		const wireN = g.wire?.transferred ?? 0;
		const lead = parts.length === 1 ? parts[0]!.transferred : Math.max(remoteN, wireN);
		const trail = parts.length === 1 ? parts[0]!.transferred : Math.min(remoteN, wireN);
		const status = itemStatus(parts);
		const primary = g.wire ?? g.remote!;
		out.push({
			id: `${opId}:stack`,
			ids: parts.map((p) => p.id),
			name: displayName(g.wire, g.remote),
			size: size || Math.max(lead, 1),
			ahead: lead,
			behind: trail,
			done: parts.every((p) => p.done) && parts.length > 0,
			status,
			direction: primary.direction,
			error: parts.find((p) => p.error)?.error,
			sha256: primary.sha256,
			integrity: primary.integrity,
			resumed: primary.resumed,
			parallelStreams: primary.parallelStreams
		});
	}

	for (const t of singles) {
		out.push({
			id: t.id,
			ids: [t.id],
			name: t.name,
			size: t.size || Math.max(t.transferred, 1),
			ahead: t.transferred,
			behind: t.transferred,
			done: t.done,
			status: t.status,
			direction: t.direction,
			error: t.error,
			sha256: t.sha256,
			integrity: t.integrity,
			resumed: t.resumed,
			parallelStreams: t.parallelStreams
		});
	}
	return out;
}

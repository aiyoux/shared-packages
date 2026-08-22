import type {
	TransferDirection,
	TransferIntegrity,
	TransferItem,
	TransferStatus
} from '../transferRegistry.js';

export type StackProgressPhase = 'compress' | 'decompress' | 'hashing' | 'transfer';

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
	/** Which pipeline stage is currently the bottleneck. */
	phase?: StackProgressPhase;
	/** Bytes on a size-unknown wire leg (streaming gzip). Not a percentage. */
	streamedBytes?: number;
	error?: string;
	sha256?: string;
	/** Digest algorithm for `sha256` (e.g. 'blake3', 'sha256'). */
	hashAlg?: string;
	integrity?: TransferIntegrity;
	resumed?: boolean;
	parallelStreams?: number;
};

const STACK_LEGS = ['compress', 'remote', 'wire', 'decompress'] as const;
type StackLeg = (typeof STACK_LEGS)[number];

function displayName(...items: Array<TransferItem | undefined>): string {
	const raw = items.find((t) => t?.name)?.name || 'File';
	const cut = raw.split(' · ')[0]?.trim();
	return cut || raw;
}

function unitOf(t: TransferItem): number {
	if (t.size <= 0) return t.done || t.status === 'done' ? 1 : 0;
	return Math.min(1, Math.max(0, t.transferred / t.size));
}

function stackPhase(
	g: Partial<Record<StackLeg, TransferItem>>,
	parts: TransferItem[]
): StackProgressPhase {
	if (g.compress && !g.compress.done && g.compress.status !== 'done' && g.compress.status !== 'failed') {
		return 'compress';
	}
	if (parts.some((p) => p.status === 'hashing')) return 'hashing';
	if (
		g.decompress &&
		!g.decompress.done &&
		g.decompress.status !== 'done' &&
		g.decompress.status !== 'failed'
	) {
		return 'decompress';
	}
	return 'transfer';
}

function itemStatus(items: TransferItem[]): TransferStatus {
	if (items.some((t) => t.status === 'failed')) return 'failed';
	if (items.length > 0 && items.every((t) => t.done || t.status === 'done')) return 'done';
	if (items.some((t) => t.status === 'hashing')) return 'hashing';
	if (items.some((t) => t.status === 'incomplete')) return 'incomplete';
	return 'active';
}

/**
 * Pair `${opId}:{compress|remote|wire|decompress}` into one stacked bar.
 *
 * Legs often have different totals (original vs compressed), so each is
 * converted to a 0–1 unit and scaled back to the largest size (the original
 * file). Same-size remote+wire pairs stay byte-identical to the old max/min.
 * Unpaired copy/send rows stay single-fill (ahead === behind).
 */
export function stackTransferItems(items: TransferItem[]): StackedProgress[] {
	const groups = new Map<string, Partial<Record<StackLeg, TransferItem>>>();
	const singles: TransferItem[] = [];

	for (const t of items) {
		const m = /^(.*):(compress|remote|wire|decompress)$/.exec(t.id);
		if (!m) {
			singles.push(t);
			continue;
		}
		const key = m[1]!;
		const leg = m[2] as StackLeg;
		const g = groups.get(key) ?? {};
		g[leg] = t;
		groups.set(key, g);
	}

	const out: StackedProgress[] = [];
	for (const [opId, g] of groups) {
		const parts = STACK_LEGS.map((leg) => g[leg]).filter((x): x is TransferItem => !!x);
		const size = Math.max(0, ...parts.map((p) => p.size || 0));
		const units = parts.map(unitOf);
		const leadPct = parts.length === 1 ? units[0]! : Math.max(...units);
		const trailPct = parts.length === 1 ? units[0]! : Math.min(...units);
		const displaySize = size || 1;
		const lead = Math.round(leadPct * displaySize);
		const trail = Math.round(trailPct * displaySize);
		const status = itemStatus(parts);
		const primary = g.wire ?? g.remote ?? g.compress ?? g.decompress!;
		const streamedBytes = parts
			.filter((p) => p.size <= 0 && p.transferred > 0)
			.reduce((n, p) => n + p.transferred, 0);
		out.push({
			id: `${opId}:stack`,
			ids: parts.map((p) => p.id),
			name: displayName(g.wire, g.remote, g.compress, g.decompress),
			size: displaySize,
			ahead: lead,
			behind: trail,
			done: parts.every((p) => p.done) && parts.length > 0,
			status,
			direction: primary.direction,
			phase: stackPhase(g, parts),
			streamedBytes: streamedBytes || undefined,
			error: parts.find((p) => p.error)?.error,
			sha256: primary.sha256,
			hashAlg: primary.hashAlg,
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
			hashAlg: t.hashAlg,
			integrity: t.integrity,
			resumed: t.resumed,
			parallelStreams: t.parallelStreams
		});
	}
	return out;
}

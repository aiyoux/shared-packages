/**
 * Tab-side WebRTC ferry: the browser only exchanges offer/answer.
 * Daemons own RTCPeerConnection. ICE-fail falls back to dual-phase
 * writeExactName on the dest name reserved before jobs start.
 */
import { EXPLORER_DOWNLOAD_MAX_BYTES, type ExplorerEntry } from '../ui/explorerDriver.js';
import { childId } from './pathIds.js';
import type { MonitorNdjsonEvent, MonitorTransport, MonitorWebrtcJob } from './client.js';

const OFFER_POLL_MS = 200;
const OFFER_WAIT_MS = 30_000;

export type WebrtcFerryProgress = {
	transferred: number;
	size?: number;
	ice?: 'checking' | 'connected' | 'failed';
	icePath?: 'host' | 'stun';
	done?: boolean;
	error?: string;
};

export type WebrtcCopyPeer = {
	uniqueName(parentId: string | null, base: string): Promise<string>;
	absolutePath(id: string): string;
	writeExactName(
		parentId: string | null,
		file: File,
		exactName: string,
		opts?: {
			onProgress?: (transferred: number, total?: number) => void;
			signal?: AbortSignal;
		}
	): Promise<unknown>;
	download?(
		id: string,
		opts?: {
			onProgress?: (transferred: number, total?: number) => void;
			signal?: AbortSignal;
		}
	): Promise<Blob>;
	readBlob?(id: string): Promise<Blob>;
	monitorClient: MonitorTransport;
};

export async function ferryWebrtcCopy(args: {
	source: WebrtcCopyPeer;
	dest: WebrtcCopyPeer;
	entry: ExplorerEntry;
	destParentId: string | null;
	onProgress?: (ev: WebrtcFerryProgress) => void;
	confirmDualPhase?: () => Promise<boolean>;
	signal?: AbortSignal;
}): Promise<void> {
	const { source, dest, entry, destParentId, onProgress, confirmDualPhase, signal } = args;
	const destName = await dest.uniqueName(destParentId, entry.name);
	const destRel = childId(destParentId, destName, false);
	const toAbs = dest.absolutePath(destRel);
	const fromAbs = source.absolutePath(entry.id);

	onProgress?.({ transferred: 0, size: entry.size, ice: 'checking' });

	let sourceJob: MonitorWebrtcJob | null = null;
	let destJob: MonitorWebrtcJob | null = null;
	try {
		sourceJob = await source.monitorClient.webrtcCreateJob({
			role: 'offerer',
			from: fromAbs,
			size: entry.size
		});
		destJob = await dest.monitorClient.webrtcCreateJob({
			role: 'answerer',
			to: toAbs,
			size: entry.size
		});

		const offer = await waitForOffer(source.monitorClient, sourceJob, signal);
		const answer = await dest.monitorClient.webrtcPostAnswer(
			destJob.jobId,
			destJob.token,
			offer.sdp,
			{ signal }
		);
		if (!answer.sdp) throw new Error('Monitor webrtc answer missing sdp');
		await source.monitorClient.webrtcPostAnswer(sourceJob.jobId, sourceJob.token, answer.sdp, {
			signal
		});

		await dest.monitorClient.webrtcProgress(destJob.jobId, destJob.token, {
			signal,
			onEvent: (ev) => {
				onProgress?.(eventToProgress(ev));
				if (ev.ice === 'failed' || (ev.error && /ice/i.test(ev.error))) {
					throw new WebrtcIceFailedError(ev.error || 'ICE failed');
				}
			}
		});
		onProgress?.({
			transferred: entry.size ?? 1,
			size: entry.size,
			ice: 'connected',
			done: true
		});
	} catch (e) {
		if (isUserAbort(e, signal)) throw e;
		const iceFailed = e instanceof WebrtcIceFailedError || isFerryFailure(e);
		if (!iceFailed) throw e;
		onProgress?.({
			transferred: 0,
			size: entry.size,
			ice: 'failed',
			error: e instanceof Error ? e.message : String(e)
		});
		const aborted = await abortBoth(source.monitorClient, dest.monitorClient, sourceJob, destJob);
		if (!aborted) {
			throw e instanceof Error ? e : new Error(String(e));
		}
		await waitUnlink(dest.monitorClient, toAbs);
		const ok = confirmDualPhase ? await confirmDualPhase() : false;
		if (!ok) {
			throw e instanceof Error ? e : new Error(String(e));
		}
		await dualPhaseExact(source, dest, entry, destParentId, destName, onProgress, signal);
	}
}

class WebrtcIceFailedError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'WebrtcIceFailedError';
	}
}

function eventToProgress(ev: MonitorNdjsonEvent): WebrtcFerryProgress {
	return {
		transferred: ev.transferred ?? 0,
		size: ev.size,
		ice: ev.ice,
		icePath: ev.icePath,
		done: ev.done,
		error: ev.error
	};
}

function isUserAbort(e: unknown, signal?: AbortSignal): boolean {
	if (signal?.aborted) return true;
	return e instanceof Error && (e.name === 'AbortError' || /cancelled/i.test(e.message));
}

function isFerryFailure(e: unknown): boolean {
	if (!(e instanceof Error)) return true;
	const msg = e.message || '';
	return /ice|timed out|timeout|failed \(\d+\)|Cannot reach monitor|webrtc/i.test(msg);
}

function shouldThrowOfferError(err: Error): boolean {
	const msg = err.message;
	if (/404|409|not ready|pending/i.test(msg)) return false;
	if (/timed out|Cannot reach|failed \([45]/i.test(msg) && !/404|409/.test(msg)) {
		const status = msg.match(/failed \((\d+)\)/);
		const code = status ? Number(status[1]) : 0;
		if (code >= 500 || /timed out|Cannot reach/.test(msg)) return true;
	}
	return false;
}

async function waitForOffer(
	client: MonitorTransport,
	job: MonitorWebrtcJob,
	signal?: AbortSignal
): Promise<{ sdp: string }> {
	const deadline = Date.now() + OFFER_WAIT_MS;
	let last: Error | null = null;
	if (signal?.aborted) throw new Error('Monitor webrtc cancelled');
	try {
		const offer = await client.webrtcCreateOffer(job.jobId, job.token, { signal });
		if (offer.sdp) return offer;
	} catch (e) {
		last = e instanceof Error ? e : new Error(String(e));
		if (shouldThrowOfferError(last)) throw last;
	}
	while (Date.now() < deadline) {
		if (signal?.aborted) throw new Error('Monitor webrtc cancelled');
		try {
			const offer = await client.webrtcGetOffer(job.jobId, job.token, { signal });
			if (offer.sdp) return offer;
		} catch (e) {
			last = e instanceof Error ? e : new Error(String(e));
			if (shouldThrowOfferError(last)) throw last;
		}
		await sleep(OFFER_POLL_MS, signal);
	}
	throw last ?? new Error('Monitor webrtc offer timed out');
}

async function abortBoth(
	source: MonitorTransport,
	dest: MonitorTransport,
	sourceJob: MonitorWebrtcJob | null,
	destJob: MonitorWebrtcJob | null
): Promise<boolean> {
	if (!sourceJob || !destJob) return false;
	try {
		await Promise.all([
			source.webrtcAbort(sourceJob.jobId, sourceJob.token),
			dest.webrtcAbort(destJob.jobId, destJob.token)
		]);
		return true;
	} catch {
		return false;
	}
}

async function waitUnlink(client: MonitorTransport, toAbs: string): Promise<void> {
	try {
		await client.unlink(toAbs);
	} catch {
		/* abort may have already removed it */
	}
}

async function dualPhaseExact(
	source: WebrtcCopyPeer,
	dest: WebrtcCopyPeer,
	entry: ExplorerEntry,
	destParentId: string | null,
	exactName: string,
	onProgress?: (ev: WebrtcFerryProgress) => void,
	signal?: AbortSignal
): Promise<void> {
	if (entry.size != null && entry.size > EXPLORER_DOWNLOAD_MAX_BYTES) {
		throw new Error('File exceeds download size cap');
	}
	let blob: Blob;
	if (source.download) {
		blob = await source.download(entry.id, {
			signal,
			onProgress: (transferred, total) => {
				onProgress?.({
					transferred,
					size: total ?? entry.size,
					ice: 'failed'
				});
			}
		});
	} else if (source.readBlob) {
		blob = await source.readBlob(entry.id);
	} else {
		throw new Error('Source cannot read file bytes');
	}
	if (blob.size > EXPLORER_DOWNLOAD_MAX_BYTES) {
		throw new Error('File exceeds download size cap');
	}
	const file = new File([blob], exactName, {
		type: entry.contentType || blob.type || 'application/octet-stream'
	});
	await dest.writeExactName(destParentId, file, exactName, {
		signal,
		onProgress: (transferred, total) => {
			onProgress?.({
				transferred,
				size: total ?? blob.size,
				ice: 'failed'
			});
		}
	});
	onProgress?.({ transferred: blob.size, size: blob.size, ice: 'failed', done: true });
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
	return new Promise((resolve, reject) => {
		if (signal?.aborted) {
			reject(new Error('Monitor webrtc cancelled'));
			return;
		}
		const t = setTimeout(resolve, ms);
		const onAbort = () => {
			clearTimeout(t);
			reject(new Error('Monitor webrtc cancelled'));
		};
		signal?.addEventListener('abort', onAbort, { once: true });
	});
}

export function isWebrtcCopyPeer(d: {
	uniqueName?: unknown;
	absolutePath?: unknown;
	writeExactName?: unknown;
	monitorClient?: unknown;
}): d is WebrtcCopyPeer {
	return (
		typeof d.uniqueName === 'function' &&
		typeof d.absolutePath === 'function' &&
		typeof d.writeExactName === 'function' &&
		!!d.monitorClient
	);
}

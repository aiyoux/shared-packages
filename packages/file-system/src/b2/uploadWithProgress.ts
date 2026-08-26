/**
 * Small-file B2 upload with request-body progress.
 *
 * The SDK's `uploadSmallFile` only calls `onProgress` after the whole PUT
 * (`tracker.addBytes` at the end). Browser `fetch` has no upload progress, so
 * we POST with XHR when CORS allows, else stream through the same-origin
 * data-plane relay via {@link fetchPutBlob}.
 */
import { encodeFileName } from '@backblaze-labs/b2-sdk/raw';
import { fetchPutBlob, xhrPostBlob } from '../uploadProgress.js';
import {
	B2_DATA_PLANE_RELAY_PATH,
	B2_RELAY_METHOD_HEADER,
	B2_RELAY_URL_HEADER
} from './dataPlaneRelay.js';

export async function sha1HexOfBlob(blob: Blob): Promise<string> {
	const digest = await crypto.subtle.digest('SHA-1', await blob.arrayBuffer());
	return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
}

export function b2UploadHeaders(args: {
	authorization: string;
	fileName: string;
	contentType: string;
	contentSha1: string;
}): Record<string, string> {
	return {
		Authorization: args.authorization,
		'X-Bz-File-Name': encodeFileName(args.fileName),
		'Content-Type': args.contentType,
		'X-Bz-Content-Sha1': args.contentSha1
	};
}

function isBrowserCorsFailure(e: unknown): boolean {
	if (e instanceof TypeError) return true;
	const msg = e instanceof Error ? e.message : String(e ?? '');
	return /failed to fetch|networkerror|load failed|cors/i.test(msg);
}

function absoluteAppPath(path: string): string {
	if (path.startsWith('http://') || path.startsWith('https://')) return path;
	if (typeof window !== 'undefined') return `${window.location.origin}${path}`;
	return path;
}

export type B2UploadFileInfo = {
	fileId: string;
	fileName: string;
	contentLength: number;
	contentType: string;
	uploadTimestamp: number;
};

function parseUploadBody(status: number, text: string, fallbackSize: number): B2UploadFileInfo {
	if (status < 200 || status >= 300) {
		let msg = text.trim() || `B2 upload failed (${status})`;
		try {
			const j = JSON.parse(text) as { message?: string; code?: string };
			msg = [j.message?.trim(), j.code].filter(Boolean).join(' · ') || msg;
		} catch {
			/* keep */
		}
		throw new Error(msg);
	}
	const json = JSON.parse(text || '{}') as Partial<B2UploadFileInfo>;
	if (!json.fileId || !json.fileName) {
		throw new Error('B2 upload returned no file metadata');
	}
	return {
		fileId: json.fileId,
		fileName: json.fileName,
		contentLength: json.contentLength ?? fallbackSize,
		contentType: json.contentType || 'b2/x-auto',
		uploadTimestamp: json.uploadTimestamp ?? Date.now()
	};
}

export async function uploadB2SmallFileWithProgress(args: {
	uploadUrl: string;
	authorizationToken: string;
	fileName: string;
	file: Blob;
	contentType?: string;
	contentSha1: string;
	signal?: AbortSignal;
	onProgress?: (pct: number) => void;
	relayPath?: string;
	fetchImpl?: typeof fetch;
}): Promise<B2UploadFileInfo> {
	const headers = b2UploadHeaders({
		authorization: args.authorizationToken,
		fileName: args.fileName,
		contentType: args.contentType || 'b2/x-auto',
		contentSha1: args.contentSha1
	});
	args.onProgress?.(0);

	if (typeof XMLHttpRequest !== 'undefined') {
		try {
			const res = await xhrPostBlob({
				url: args.uploadUrl,
				body: args.file,
				headers,
				signal: args.signal,
				onProgress: args.onProgress
			});
			return parseUploadBody(res.status, await res.text(), args.file.size);
		} catch (e) {
			if (!isBrowserCorsFailure(e)) throw e;
		}
	}

	const relayPath = args.relayPath === undefined ? B2_DATA_PLANE_RELAY_PATH : args.relayPath;
	if (!relayPath) {
		throw new Error('B2 upload blocked (CORS) and no data-plane relay is configured');
	}
	const fetchImpl = args.fetchImpl ?? fetch;
	const res = await fetchPutBlob({
		url: absoluteAppPath(relayPath),
		body: args.file,
		headers: {
			...headers,
			[B2_RELAY_URL_HEADER]: args.uploadUrl,
			[B2_RELAY_METHOD_HEADER]: 'POST'
		},
		signal: args.signal,
		onProgress: (sent, total) => args.onProgress?.(total > 0 ? sent / total : 0),
		fetchImpl,
		extraInit: { method: 'POST' }
	});
	return parseUploadBody(res.status, await res.text(), args.file.size);
}

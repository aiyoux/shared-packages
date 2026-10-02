/** Monitor-side model management: the curated downloadable library and the
 * native-model rows that turn an installed model file into a live catalog
 * offer. Install and enable are separate steps, mirroring profile install
 * and use: the daemon downloads the file server-side, and a managed row
 * (persisted to `ai-native-models.toml` next to the monitor config) publishes
 * it as `native:<modelId>` in `/v1/ai/catalog` without a daemon restart. */
import { AiCredentialsError } from './errors.js';
import { aiMonitorRequest } from './catalog.js';
import type { AiDeviceClass, AiTask } from './catalog.js';

export type AiLibraryEntry = {
	id: string;
	name: string;
	task: AiTask;
	/** Runtime binary the enabled offer needs, by name (e.g. `whisper-cli`). */
	runtime: string;
	fileName: string;
	/** Upstream URL the daemon downloads from (compile-time constant). */
	url: string;
	/** Approximate published size; the daemon enforces hard bounds itself. */
	sizeBytes: number;
	license: string;
	licenseUrl: string;
	/** Absolute path of the installed file, when present on the monitor. */
	installedPath?: string;
	installedBytes?: number;
};

export type AiLibraryListResult = {
	/** Monitor directory the files install into. */
	dir: string;
	entries: AiLibraryEntry[];
};

function parseEntry(raw: unknown): AiLibraryEntry | null {
	if (!raw || typeof raw !== 'object') return null;
	const row = raw as Record<string, unknown>;
	if (typeof row.id !== 'string' || typeof row.name !== 'string' ||
		typeof row.task !== 'string' || typeof row.runtime !== 'string' ||
		typeof row.fileName !== 'string' || typeof row.url !== 'string' ||
		typeof row.sizeBytes !== 'number' || typeof row.license !== 'string') {
		return null;
	}
	const entry: AiLibraryEntry = {
		id: row.id, name: row.name, task: row.task as AiTask,
		runtime: row.runtime, fileName: row.fileName, url: row.url,
		sizeBytes: row.sizeBytes, license: row.license,
		licenseUrl: typeof row.licenseUrl === 'string' ? row.licenseUrl : ''
	};
	if (typeof row.installedPath === 'string' && row.installedPath) entry.installedPath = row.installedPath;
	if (typeof row.installedBytes === 'number' && Number.isFinite(row.installedBytes)) {
		entry.installedBytes = row.installedBytes;
	}
	return entry;
}

/** The curated model library with installed state on this monitor. */
export async function listAiLibrary(baseUrl: string, signal?: AbortSignal): Promise<AiLibraryListResult> {
	const response = await aiMonitorRequest(baseUrl, '/v1/ai/library', { signal });
	const body = (await response.json()) as { dir?: unknown; entries?: unknown };
	return {
		dir: typeof body.dir === 'string' ? body.dir : '',
		entries: Array.isArray(body.entries)
			? body.entries.flatMap((row) => { const parsed = parseEntry(row); return parsed ? [parsed] : []; })
			: []
	};
}

/** Download a curated model file onto the monitor (server-side; the browser
 * never touches the upstream host). Long-running: a few hundred MiB over a
 * slow link takes minutes. 409 `AI_BUSY` while another install runs. */
export async function installAiLibraryModel(
	baseUrl: string,
	id: string,
	opts: { signal?: AbortSignal } = {}
): Promise<AiLibraryEntry> {
	const response = await aiMonitorRequest(
		baseUrl,
		`/v1/ai/library/${encodeURIComponent(id)}/install`,
		{ method: 'POST', signal: opts.signal }
	);
	const body = (await response.json()) as unknown;
	const parsed = parseEntry(body);
	if (!parsed) throw new AiCredentialsError('AI_ERROR', 'Monitor returned an unreadable library entry.');
	return parsed;
}

/** Remove an installed model file. Refused (`409 AI_BUSY` code
 * `ai.model_in_use`) while a native-model row still references it. */
export async function removeAiLibraryModel(
	baseUrl: string,
	id: string,
	opts: { signal?: AbortSignal } = {}
): Promise<void> {
	await aiMonitorRequest(baseUrl, `/v1/ai/library/${encodeURIComponent(id)}`, {
		method: 'DELETE', signal: opts.signal
	});
}

export type AiNativeFlux2Config = {
	variant: '4b' | '9b';
	/** Absolute paths on the Monitor host. */
	vae: string;
	llm: string;
};

export type AiNativeModelRow = {
	id: string;
	name: string;
	task: AiTask;
	device: 'cpu' | 'gpu';
	binary: string;
	model: string;
	backend: string | null;
	flux2?: AiNativeFlux2Config | null;
	vae: string | null;
	textEncoder: string | null;
	width: number | null;
	height: number | null;
	source: 'config' | 'managed';
};

function parseRow(raw: unknown): AiNativeModelRow | null {
	if (!raw || typeof raw !== 'object') return null;
	const row = raw as Record<string, unknown>;
	if (typeof row.id !== 'string' || typeof row.name !== 'string' ||
		typeof row.binary !== 'string' || typeof row.model !== 'string') return null;
	if (!['chat', 'text-to-speech', 'image-generation', 'transcription'].includes(String(row.task))) return null;
	if (!['cpu', 'gpu'].includes(String(row.device))) return null;
	let flux2: AiNativeFlux2Config | null = null;
	if (row.flux2 != null) {
		const config = row.flux2 as Partial<AiNativeFlux2Config>;
		if ((config.variant !== '4b' && config.variant !== '9b') || typeof config.vae !== 'string' || typeof config.llm !== 'string') return null;
		flux2 = { variant: config.variant, vae: config.vae, llm: config.llm };
	}
	const dim = (value: unknown): number | null =>
		typeof value === 'number' && Number.isInteger(value) ? value : null;
	return {
		id: row.id, name: row.name, task: row.task as AiTask,
		device: row.device as 'cpu' | 'gpu', binary: row.binary, model: row.model,
		backend: typeof row.backend === 'string' ? row.backend : null,
		flux2,
		vae: typeof row.vae === 'string' ? row.vae : null,
		textEncoder: typeof row.textEncoder === 'string' ? row.textEncoder : null,
		width: dim(row.width),
		height: dim(row.height),
		source: row.source === 'managed' ? 'managed' : 'config'
	};
}

/** Native model rows: config baseline plus UI-installed managed rows. */
export async function listAiNativeModels(baseUrl: string, signal?: AbortSignal): Promise<AiNativeModelRow[]> {
	const response = await aiMonitorRequest(baseUrl, '/v1/ai/native-models', { signal });
	const body = (await response.json()) as { models?: unknown };
	return Array.isArray(body.models)
		? body.models.flatMap((row) => { const parsed = parseRow(row); return parsed ? [parsed] : []; })
		: [];
}

export type AiNativeModelInput = {
	/** Omitted: the monitor generates a unique id. */
	id?: string;
	name: string;
	task: AiTask;
	device: 'cpu' | 'gpu';
	/** Absolute path to the runtime binary on the monitor host. */
	binary: string;
	/** Absolute path to the model file on the monitor host; it must exist. */
	model: string;
	/** `sd-cli --backend` selector (image generation only). */
	backend?: string;
	/** Omit for a complete Stable Diffusion checkpoint. */
	flux2?: AiNativeFlux2Config;
	/** Component files for multi-file image runtimes (image generation only). */
	vae?: string;
	textEncoder?: string;
	/** Output resolution per side, 128–2048 (image generation only). */
	width?: number;
	height?: number;
};

/** Install a managed native model row; it appears in `/v1/ai/catalog` as
 * `native:<id>` immediately. The monitor validates the row and requires the
 * model file to exist. */
export async function addAiNativeModel(
	baseUrl: string,
	input: AiNativeModelInput,
	signal?: AbortSignal
): Promise<AiNativeModelRow> {
	const response = await aiMonitorRequest(baseUrl, '/v1/ai/native-models', {
		method: 'POST', headers: { 'content-type': 'application/json' }, signal,
		body: JSON.stringify(input)
	});
	const body = (await response.json()) as { model?: unknown };
	const parsed = parseRow((body as Record<string, unknown> | null)?.model ?? null);
	if (!parsed) throw new AiCredentialsError('AI_ERROR', 'Monitor returned an unreadable native model.');
	return parsed;
}

/** Remove a managed native model row. Config rows are wire-immutable
 * (`409` code `ai.model_readonly`). */
export async function deleteAiNativeModel(baseUrl: string, id: string, signal?: AbortSignal): Promise<void> {
	await aiMonitorRequest(baseUrl, `/v1/ai/native-models/${encodeURIComponent(id)}`, {
		method: 'DELETE', signal
	});
}

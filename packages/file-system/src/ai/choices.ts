/**
 * Model choices across this browser and every saved monitor.
 *
 * A choice is an offer plus the runtime that serves it: this browser, or one
 * saved monitor profile. Picking a model therefore picks its monitor, and the
 * durable ref carries that monitor's profile id. Nothing here chooses a
 * monitor for the user — there is no active monitor and no first-reachable
 * fallback. A ref that names a monitor resolves on that monitor, or the
 * caller says why it cannot (`describeMissingAiChoice`).
 *
 * Every app that lists models reads this one list and its one label, instead
 * of resolving "the" monitor and re-listing its catalog itself.
 */
import { createMonitorClient } from '../monitor/client.js';
import { getProfile, listProfiles } from '../monitor/credentials.js';
import { listAiOffers, type AiCatalog, type AiOffer, type AiTask } from './catalog.js';
import { AiCredentialsError } from './errors.js';
import { listAiProfiles, type AiCapabilities } from './monitor.js';
import { matchAiModelRef, offerAiRef, type AiModelRef } from './selection.js';

/** The in-browser chat model (run by `@shared-packages/speech`'s browser chat). */
export const BROWSER_CHAT_MODEL = 'onnx-community/SmolLM2-135M-Instruct-ONNX';

/** The browser chat model as catalog offers: CPU always, GPU when WebGPU hands
 * out an adapter. Text only. `variantId` is the device it runs on. */
export async function browserChatOffers(): Promise<AiOffer[]> {
	let gpu = false;
	try {
		const nav = navigator as Navigator & { gpu?: { requestAdapter: () => Promise<unknown> } };
		gpu = !!(await nav.gpu?.requestAdapter());
	} catch { /* CPU remains available */ }
	const offer = (device: 'wasm' | 'webgpu'): AiOffer => ({
		id: `browser:smollm2-135m:${device === 'webgpu' ? 'gpu' : 'cpu'}`, name: 'SmolLM2 135M', task: 'chat',
		location: 'browser', modelId: BROWSER_CHAT_MODEL, sourceId: 'this-browser', variantId: device,
		deviceClass: device === 'webgpu' ? 'gpu' : 'cpu', supported: true, ready: true, available: true, reason: null
	});
	return gpu ? [offer('wasm'), offer('webgpu')] : [offer('wasm')];
}

/** One saved monitor profile, as a run target. */
export type AiMonitorTarget = { profileId: string; name: string; baseUrl: string };

/** A saved monitor and what its daemon reports; `error` when unreachable. */
export type AiMonitorStatus = AiMonitorTarget & {
	/** The daemon's AI capabilities; null when unreachable or without the AI feature. */
	capabilities: AiCapabilities | null;
	error: string | null;
};

export type AiChoice = {
	/** Unique across runtimes: the same offer id can exist on two monitors. */
	key: string;
	offer: AiOffer;
	/** Null for a model that runs in this browser. */
	monitor: AiMonitorTarget | null;
	/** Monitor-provider offers: the provider profile's name on that monitor. */
	provider: string | null;
	/** The model and how it runs, without where ("Qwen 2.5 · GPU", "gpt-4o · OpenAI"). */
	model: string;
	/** Where it runs: "This browser" or the monitor's name. */
	where: string;
	/** `${model} — ${where}`, for flat lists. */
	label: string;
	ref: AiModelRef;
};

export type AiChoiceList = {
	choices: AiChoice[];
	/** Every saved monitor, so a picker can name the unreachable ones. */
	monitors: AiMonitorStatus[];
};

const trim = (url: string) => url.replace(/\/+$/, '');

function target(profile: { id: string; name: string; baseUrl: string }): AiMonitorTarget {
	return { profileId: profile.id, name: profile.name, baseUrl: trim(profile.baseUrl) };
}

async function probe(monitor: AiMonitorTarget): Promise<AiMonitorStatus> {
	try {
		const meta = await createMonitorClient({ baseUrl: monitor.baseUrl }).meta();
		const capabilities = (meta.capabilities as { ai?: AiCapabilities } | undefined)?.ai ?? null;
		return { ...monitor, capabilities, error: capabilities ? null : 'This monitor does not serve AI.' };
	} catch (error) {
		return { ...monitor, capabilities: null, error: `Not reachable: ${error instanceof Error ? error.message : String(error)}` };
	}
}

/** Every saved monitor as a run target, without asking any daemon. */
export async function listSavedMonitors(): Promise<AiMonitorTarget[]> {
	return (await listProfiles()).map(target);
}

/** Every saved monitor with its AI capabilities. Pickers that choose a monitor
 * for something other than a model (agent access) filter this list. */
export async function listAiMonitors(): Promise<AiMonitorStatus[]> {
	const profiles = await listProfiles();
	return Promise.all(profiles.map((profile) => probe(target(profile))));
}

/** One saved monitor by profile id. Throws with the reason the caller shows
 * when the profile is gone, unreachable, or lacks the AI feature. */
export async function getAiMonitor(profileId: string): Promise<AiMonitorTarget & { capabilities: AiCapabilities }> {
	const profile = await getProfile(profileId);
	if (!profile) throw new AiCredentialsError('AI_NOT_FOUND', 'That monitor was removed. Choose another one.');
	const status = await probe(target(profile));
	if (!status.capabilities) throw new AiCredentialsError('AI_UNSUPPORTED', `${status.name}: ${status.error}`);
	return { ...target(profile), capabilities: status.capabilities };
}

// Pickers open concurrently (Settings sections, several panes). Share the
// pending daemon reads without caching a result that model edits make stale.
const pending = new Map<string, Promise<unknown>>();
function shared<T>(key: string, run: () => Promise<T>): Promise<T> {
	const current = pending.get(key) as Promise<T> | undefined;
	if (current) return current;
	const request = run().finally(() => pending.delete(key));
	pending.set(key, request);
	return request;
}

function deviceLabel(offer: AiOffer): string {
	return offer.deviceClass === 'service' ? 'API' : offer.deviceClass.toUpperCase();
}

function browserChoice(offer: AiOffer): AiChoice {
	const model = `${offer.name} · ${deviceLabel(offer)}`;
	return {
		key: `browser|${offer.id}`,
		offer,
		monitor: null,
		provider: null,
		model,
		where: 'This browser',
		label: `${model} — This browser`,
		ref: offerAiRef(offer, null)
	};
}

function monitorChoice(offer: AiOffer, monitor: AiMonitorTarget, providers: Record<string, string>): AiChoice {
	const provider = offer.location === 'monitor-provider' ? providers[offer.sourceId] ?? offer.sourceId : null;
	const model = provider ? `${offer.modelId} · ${provider}` : `${offer.name} · ${deviceLabel(offer)}`;
	return {
		key: `${monitor.profileId}|${offer.id}`,
		offer,
		monitor,
		provider,
		model,
		where: monitor.name,
		label: `${model} — ${monitor.name}`,
		ref: offerAiRef(offer, monitor.profileId)
	};
}

/**
 * Every choice for a task: the caller's browser offers (their catalogs live
 * in sibling packages) followed by each saved monitor's catalog offers.
 * Unreachable monitors are listed in `monitors` with their error, never
 * skipped silently.
 */
export async function listAiChoices(
	task: AiTask,
	opts: { browser?: readonly AiOffer[] } = {}
): Promise<AiChoiceList> {
	const browser = (opts.browser ?? []).filter((offer) => offer.task === task).map(browserChoice);
	const profiles = await listProfiles();
	const rows = await Promise.all(profiles.map(async (profile) => {
		const monitor = target(profile);
		const status = await shared(`meta:${monitor.baseUrl}`, () => probe(monitor));
		const named = { ...status, ...monitor };
		if (!status.capabilities) return { status: named, choices: [] as AiChoice[] };
		let catalog: AiCatalog;
		try {
			catalog = await shared(`catalog:${monitor.baseUrl}`, () => listAiOffers(monitor.baseUrl));
		} catch (error) {
			return { status: { ...named, error: error instanceof Error ? error.message : String(error) }, choices: [] };
		}
		// Whether an offer can run now is the daemon's `available`, not a filter here.
		const offers = catalog.offers.filter((offer) => offer.task === task &&
			(offer.location === 'monitor-provider' || offer.location === 'monitor-native'));
		let providers: Record<string, string> = {};
		if (offers.some((offer) => offer.location === 'monitor-provider')) {
			try {
				const list = await shared(`profiles:${monitor.baseUrl}`, () => listAiProfiles(monitor.baseUrl));
				providers = Object.fromEntries(list.profiles.map((row) => [row.id, row.name]));
			} catch { /* labels fall back to the provider id */ }
		}
		return { status: named, choices: offers.map((offer) => monitorChoice(offer, monitor, providers)) };
	}));
	return { choices: [...browser, ...rows.flatMap((row) => row.choices)], monitors: rows.map((row) => row.status) };
}

/**
 * The choice a saved ref names. A monitor ref matches only offers on the
 * monitor it names; a monitor ref without one (written before refs carried
 * their monitor) matches nothing, so the user picks again.
 */
export function matchAiChoice(ref: AiModelRef | null, choices: readonly AiChoice[]): AiChoice | null {
	if (!ref) return null;
	const candidates = choices.filter((choice) => ref.location === 'browser'
		? choice.monitor === null
		: !!ref.monitorProfileId && choice.monitor?.profileId === ref.monitorProfileId);
	const offer = matchAiModelRef(ref, candidates.map((choice) => choice.offer));
	return offer ? candidates.find((choice) => choice.offer === offer) ?? null : null;
}

/** Why a saved ref has no choice in this list, in words a picker shows. */
export function describeMissingAiChoice(ref: AiModelRef, list: AiChoiceList): string {
	if (ref.location === 'browser') return `${ref.modelId} is not available in this browser. Choose a model.`;
	const monitor = list.monitors.find((row) => row.profileId === ref.monitorProfileId);
	if (!monitor) return 'The monitor your model was on was removed. Choose a model.';
	if (monitor.error) return `${monitor.name} — ${monitor.error}`;
	return `${ref.modelId} is no longer offered by ${monitor.name}. Choose a model.`;
}

/**
 * Whether a chat choice can read an attached image. The catalog does not
 * declare input kinds yet: provider APIs accept image parts, while the
 * browser and monitor-native chat runtimes are text only.
 */
export function aiChoiceReadsImages(choice: AiChoice): boolean {
	return choice.offer.task === 'chat' && choice.offer.location === 'monitor-provider';
}

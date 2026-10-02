/**
 * The lazy engine registry every tool package repeats: a static catalog, one
 * dynamic import per engine id, load on first use, cache afterwards.
 *
 * The pending load is what is cached, so two callers asking at once share
 * one load instead of each importing and initialising the engine. A failed
 * load is forgotten, so the next call tries again.
 */
export function createEngineRegistry<Id extends string, Engine, Info>(opts: {
	/** Shown in the unknown-id error ("Unknown compression engine: x"). */
	kind: string;
	catalog: readonly Info[];
	/** Import and construct one engine. */
	loaders: Record<Id, () => Promise<Engine>>;
	/** Initialise a freshly imported engine (its library / WASM). */
	prepare?: (engine: Engine) => Promise<void> | void;
}) {
	const loaded = new Map<Id, Engine>();
	const pending = new Map<Id, Promise<Engine>>();

	return {
		listEngines(): readonly Info[] {
			return opts.catalog;
		},
		/** Load one engine on demand. Cached after the first call. */
		loadEngine(id: Id): Promise<Engine> {
			const hit = loaded.get(id);
			if (hit) return Promise.resolve(hit);
			const inFlight = pending.get(id);
			if (inFlight) return inFlight;
			const loader = Object.hasOwn(opts.loaders, id) ? opts.loaders[id] : undefined;
			if (!loader) return Promise.reject(new Error(`Unknown ${opts.kind} engine: ${id}`));
			const run = (async () => {
				const engine = await loader();
				await opts.prepare?.(engine);
				loaded.set(id, engine);
				return engine;
			})().finally(() => pending.delete(id));
			pending.set(id, run);
			return run;
		},
		/** The engine if it has finished loading, without loading it. */
		peekEngine(id: Id): Engine | null {
			return loaded.get(id) ?? null;
		}
	};
}

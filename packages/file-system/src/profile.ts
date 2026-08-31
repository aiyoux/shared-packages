/**
 * Opt-in extract/write phase timer. Off unless `__VFS_PROFILE__ === true`
 * on this global (the VFS worker sets it when the job asks). Zero cost when
 * off: callers still pay one boolean check per wrap.
 */
type Acc = { ms: number; n: number };

const acc = new Map<string, Acc>();

function on(): boolean {
	return (globalThis as { __VFS_PROFILE__?: boolean }).__VFS_PROFILE__ === true;
}

export function profileReset(): void {
	acc.clear();
}

/** Flip the flag and expose an add hook for sibling packages (compress). */
export function profileEnable(): void {
	(globalThis as { __VFS_PROFILE__?: boolean }).__VFS_PROFILE__ = true;
	(globalThis as { __VFS_PROFILE_ADD__?: (name: string, ms: number) => void }).__VFS_PROFILE_ADD__ =
		profileAdd;
	profileReset();
}

export function profileDisable(): void {
	(globalThis as { __VFS_PROFILE__?: boolean }).__VFS_PROFILE__ = false;
	delete (globalThis as { __VFS_PROFILE_ADD__?: unknown }).__VFS_PROFILE_ADD__;
}

export function profileAdd(name: string, ms: number): void {
	if (!on() || ms < 0) return;
	const cur = acc.get(name);
	if (cur) {
		cur.ms += ms;
		cur.n += 1;
	} else {
		acc.set(name, { ms, n: 1 });
	}
}

export async function profileWrap<T>(name: string, fn: () => Promise<T>): Promise<T> {
	if (!on()) return fn();
	const t0 = performance.now();
	try {
		return await fn();
	} finally {
		profileAdd(name, performance.now() - t0);
	}
}

export function profileDump(): Record<string, Acc> {
	const out: Record<string, Acc> = {};
	for (const [k, v] of [...acc.entries()].sort((a, b) => b[1].ms - a[1].ms)) {
		out[k] = { ms: Math.round(v.ms * 10) / 10, n: v.n };
	}
	return out;
}

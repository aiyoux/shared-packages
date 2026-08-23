// Unified toast system — module-level state so any component in the app
// can push a toast without prop drilling or context.
//
// Usage:
//   import { toast } from '@shared-packages/ui';
//   toast.error('Something went wrong');
//   toast.success('Saved');
//   toast.info('FYI');
//
// Render <ToastHost /> once at the app root (e.g. in +layout.svelte).

export type ToastKind = 'info' | 'success' | 'error' | 'warning';

export type Toast = {
	id: number;
	kind: ToastKind;
	message: string;
	/** Auto-dismiss after this many ms. 0 = sticky (manual close only). */
	duration: number;
	createdAt: number;
};

let toasts = $state<Toast[]>([]);
let seq = 0;

const DEFAULT_DURATION: Record<ToastKind, number> = {
	info: 4000,
	success: 3000,
	error: 6000,
	warning: 5000
};

function push(kind: ToastKind, message: string, duration?: number): number {
	const id = ++seq;
	const toast: Toast = {
		id,
		kind,
		message,
		duration: duration ?? DEFAULT_DURATION[kind],
		createdAt: Date.now()
	};
	toasts = [...toasts, toast];
	return id;
}

export function dismiss(id: number): void {
	toasts = toasts.filter((t) => t.id !== id);
}

export function clear(): void {
	toasts = [];
}

/** Public toast API — call from anywhere in the app. */
export const toast = {
	info: (msg: string, duration?: number) => push('info', msg, duration),
	success: (msg: string, duration?: number) => push('success', msg, duration),
	error: (msg: string, duration?: number) => push('error', msg, duration),
	warning: (msg: string, duration?: number) => push('warning', msg, duration),
	dismiss,
	clear,
	/** Push a custom toast. Returns the id for manual dismiss. */
	push: (kind: ToastKind, msg: string, duration?: number) => push(kind, msg, duration)
};

/** For the ToastHost component to read the current list. */
export function getToasts(): readonly Toast[] {
	return toasts;
}

/** For tests. */
export function __resetToastsForTests(): void {
	toasts = [];
	seq = 0;
}

// Expose on window for E2E testing (guarded for SSR).
if (typeof window !== 'undefined') {
	(window as unknown as { __toast?: typeof toast }).__toast = toast;
}

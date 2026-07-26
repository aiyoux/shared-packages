/**
 * Module-level dialog nest stack (not Svelte context).
 *
 * Portaled dialogs break context inheritance, so Escape ownership, body
 * scroll-lock, and depth/z-index are tracked here as a process-local
 * singleton. Internal to Dialog — consumers should not depend on this API
 * except tests.
 */

export type DialogStackEntry = {
  id: symbol;
};

const stack: DialogStackEntry[] = [];
let bodyOverflowSaved: string | null = null;

/** 0-based depth after push; first open modal is depth 0. */
export function pushDialog(id: symbol): number {
  stack.push({ id });
  if (stack.length === 1 && typeof document !== 'undefined') {
    bodyOverflowSaved = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
  }
  return stack.length - 1;
}

export function popDialog(id: symbol): void {
  const idx = stack.findIndex((e) => e.id === id);
  if (idx === -1) return;
  stack.splice(idx, 1);
  if (stack.length === 0 && typeof document !== 'undefined') {
    document.body.style.overflow = bodyOverflowSaved ?? '';
    bodyOverflowSaved = null;
  }
}

export function isTopDialog(id: symbol): boolean {
  return stack.length > 0 && stack[stack.length - 1]!.id === id;
}

export function getDialogDepth(id: symbol): number {
  return stack.findIndex((e) => e.id === id);
}

/** Reads `--z-modal-backdrop` (fallback 2000). z-index = base + depth * 10. */
export function getModalBaseZ(): number {
  if (typeof document === 'undefined') return 2000;
  const raw = getComputedStyle(document.documentElement)
    .getPropertyValue('--z-modal-backdrop')
    .trim();
  const n = parseInt(raw, 10);
  return Number.isFinite(n) ? n : 2000;
}

let titleSeq = 0;

/** Unique title id per Dialog instance (avoids fixed `dialog-title` collisions). */
export function nextDialogTitleId(): string {
  titleSeq += 1;
  return `dialog-title-${titleSeq}`;
}

/** Test-only reset. */
export function __resetDialogStackForTests(): void {
  stack.length = 0;
  bodyOverflowSaved = null;
  titleSeq = 0;
}

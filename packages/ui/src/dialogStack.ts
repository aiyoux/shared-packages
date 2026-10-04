/**
 * Compatibility facade for the shared overlay controller. Dialog and Popover
 * register directly with that controller; legacy tests can still use this API.
 */

import {
	registerOverlay,
	isTopOverlay,
	overlayDepth,
	overlayBaseZ
} from '@shared-packages/design-system';
const dialogs = new Map<symbol, ReturnType<typeof registerOverlay>>();
export type DialogStackEntry = { id: symbol };
/** Compatibility facade; Dialog and Popover now share the design-system registry. */
export function pushDialog(id: symbol): number {
	dialogs.set(id, registerOverlay(id, undefined, { kind: 'modal' }));
	return overlayDepth(id);
}
export function popDialog(id: symbol): void {
	dialogs.get(id)?.destroy();
	dialogs.delete(id);
}
export const isTopDialog = isTopOverlay;
export const getDialogDepth = overlayDepth;
export const getModalBaseZ = overlayBaseZ;

let titleSeq = 0;

/** Unique title id per Dialog instance (avoids fixed `dialog-title` collisions). */
export function nextDialogTitleId(): string {
	titleSeq += 1;
	return `dialog-title-${titleSeq}`;
}

/** Test-only reset. */
export function __resetDialogStackForTests(): void {
	for (const dialog of dialogs.values()) dialog.destroy();
	dialogs.clear();
	titleSeq = 0;
}

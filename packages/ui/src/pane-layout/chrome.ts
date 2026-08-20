/** Portal target id for an app to inject header items into a pane's chrome. */
export function paneChromeSlotId(leafId: string): string {
	return `pl-chrome-app-${leafId}`;
}

/**
 * Empty flex slot in the split tree where a keyed leaf is homed.
 * Closing/splitting reshapes the tree; leaf instances stay alive by moving
 * into the new slot instead of remounting.
 */
export function paneLeafSlotId(leafId: string): string {
	return `pl-leaf-slot-${leafId}`;
}

/** Portal target id for an app to inject header items into a pane's chrome. */
export function paneChromeSlotId(leafId: string): string {
	return `pl-chrome-app-${leafId}`;
}

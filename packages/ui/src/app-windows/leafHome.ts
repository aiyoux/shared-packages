let instanceSeq = 0;

/** Unique `layoutId` per AppWindows mount. Own counter — must not steal
 *  pane-layout `newLayoutId()`, or the first Files split becomes `leaf-2`
 *  and anything that still names `files-pane-leaf-1` misses. */
export function nextAppWindowLayoutId(base: string): string {
	instanceSeq += 1;
	return `${base}-${instanceSeq}`;
}

export function resetAppWindowLayoutIdsForTests(): void {
	instanceSeq = 0;
}

/** Slot element id. `layoutId` must be unique per AppWindows mount. */
export function appWindowSlotId(layoutId: string, leafId: string): string {
	return `aw-${layoutId}-slot-${leafId}`;
}

/** Body element id. `layoutId` must be unique per AppWindows mount. */
export function appWindowBodyId(layoutId: string, leafId: string): string {
	return `aw-${layoutId}-body-${leafId}`;
}

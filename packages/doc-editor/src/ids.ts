export function newBlockId(): string {
	return crypto.randomUUID();
}

/** Attribute values inside `[attr="…"]` selectors. `CSS.escape` when present, quotes otherwise. */
export function cssEscape(value: string): string {
	if (typeof CSS !== 'undefined' && typeof CSS.escape === 'function') return CSS.escape(value);
	return value.replace(/"/g, '\\"');
}

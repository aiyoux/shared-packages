/** UTF-16 high surrogate: 0xD800–0xDBFF */
export function isHighSurrogate(code: number): boolean {
	return code >= 0xd800 && code <= 0xdbff;
}

/** UTF-16 low surrogate: 0xDC00–0xDFFF */
export function isLowSurrogate(code: number): boolean {
	return code >= 0xdc00 && code <= 0xdfff;
}

/**
 * Legal offsets never sit between a surrogate pair.
 * An interior index that lands on a low surrogate after a high snaps to the high-surrogate index.
 * Out-of-range values are not clamped here (apply throws); this only snaps inside a pair.
 */
export function snapOffset(text: string, offset: number): number {
	if (offset <= 0) return 0;
	if (offset >= text.length) return text.length;
	if (isLowSurrogate(text.charCodeAt(offset)) && isHighSurrogate(text.charCodeAt(offset - 1))) {
		return offset - 1;
	}
	return offset;
}

export function hasUnpairedSurrogate(text: string): boolean {
	for (let i = 0; i < text.length; i++) {
		const c = text.charCodeAt(i);
		if (isHighSurrogate(c)) {
			if (i + 1 >= text.length || !isLowSurrogate(text.charCodeAt(i + 1))) return true;
			i++;
		} else if (isLowSurrogate(c)) {
			return true;
		}
	}
	return false;
}

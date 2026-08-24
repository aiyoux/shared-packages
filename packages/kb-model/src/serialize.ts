import { normalizePage } from './normalize.js';
import type { KbPage } from './types.js';

export function serializeKb(page: KbPage): string {
	return `${JSON.stringify(normalizePage(page), null, 2)}\n`;
}

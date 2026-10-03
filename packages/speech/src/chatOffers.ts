/**
 * Chat offers for this browser, limited to models actually loaded in the
 * browser model store (Settings → AI models).
 *
 * The offer itself — its id, name, ref shape — stays single-sourced in
 * file-system's `browserChatOffers`; speech, which owns the chat model defs
 * and imports the model store, only supplies the readiness. A dropdown that
 * calls this never shows a variant whose files were not imported, and keeps
 * the same identity a saved model ref names.
 */
import { browserChatOffers, type AiOffer } from '@shared-packages/file-system/ai';
import type { ModelDef } from '@shared-packages/model-store';
import { browserModelStore } from '@shared-packages/model-store';
import { BROWSER_CHAT_MODELS } from './models.js';

/** The def a chat offer's device variant runs from the browser store. */
export function chatBrowserModelDef(offer: AiOffer): ModelDef {
	return BROWSER_CHAT_MODELS[offer.variantId === 'webgpu' ? 'webgpu' : 'wasm'].model;
}

export async function chatBrowserOffers(): Promise<AiOffer[]> {
	return browserChatOffers(async (offer) => {
		try {
			return (await browserModelStore.status(chatBrowserModelDef(offer))).ready;
		} catch {
			// Store unavailable or the def unknown — do not offer the model.
			return false;
		}
	});
}
/**
 * Custom DOM events FileExplorer dispatches, declared so consumers can bind
 * them with `on<name>={...}` like any other event.
 *
 * `FileExplorer.svelte` fires `feexplorerdragbegin` / `feexplorerdragend` as
 * bubbling, composed CustomEvents for pointer-driven (non-HTML5) dragging.
 * Without this augmentation Svelte types them as unknown props on the element
 * and reports "does not exist in type HTMLProps", plus an implicit-any handler
 * parameter.
 */
import 'svelte/elements';

declare module 'svelte/elements' {
	export interface HTMLAttributes<T extends EventTarget> {
		'onfeexplorerdragbegin'?: (
			event: CustomEvent<{ ids: string[] }> & { currentTarget: EventTarget & T }
		) => void;
		'onfeexplorerdragend'?: (
			event: CustomEvent<undefined> & { currentTarget: EventTarget & T }
		) => void;
	}
}

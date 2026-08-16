/** All clock and clip times are milliseconds — never VoiceRec seconds. */

export interface ClockState {
	timeMs: number;
	durationMs: number;
	playing: boolean;
	/** 1 = realtime */
	rate: number;
}

export interface CompositionClock {
	get(): ClockState;
	subscribe(fn: (s: ClockState) => void): () => void;
	play(): void;
	pause(): void;
	seek(timeMs: number): void;
	setDuration(durationMs: number): void;
	setRate(rate: number): void;
	dispose(): void;
}

export type TrackRole = 'media' | 'graphics';

export interface Clip {
	id: string;
	/** `'media'` | `'igfx'` | future kinds registered via `registerClipRenderer`. */
	kind: string;
	startMs: number;
	durationMs: number;
	offsetMs: number;
	/** Opaque; kind-specific. Renderers interpret this, composition does not. */
	payload: unknown;
}

export interface Track {
	id: string;
	role: TrackRole;
	clips: Clip[];
}

export interface CompositionDoc {
	durationMs: number;
	width: number;
	height: number;
	/** v1: exactly one media + one graphics track. */
	tracks: Track[];
}

/** Alias used by the package brief; same type as `CompositionDoc`. */
export type Composition = CompositionDoc;

export interface ActiveSample {
	track: Track;
	clip: Clip;
	/** Already adjusted: `tMs - clip.startMs + clip.offsetMs`. */
	localMs: number;
}

export interface ClipRenderer {
	kind: string;
	/**
	 * Mount preview into `host`. Return a disposer; composition UI **must**
	 * call it before the next preview() or on unmount.
	 */
	preview(clip: Clip, localMs: number, host: HTMLElement): () => void;
	pullFrame(
		clip: Clip,
		localMs: number,
		size: { w: number; h: number }
	): Promise<CanvasImageSource | VideoFrame>;
	durationOf?(clip: Clip): number;
}

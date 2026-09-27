/**
 * Shared playback + text helpers for TTS engines. Extracted from kokoroTts
 * so piper (and future engines) stream sentences through one AudioContext.
 */

import type { TtsRender } from '../types.js';

/** Play rendered segments back-to-back; one AudioContext, cancelable. */
export class SegmentPlayer {
	private ctx: AudioContext | null = null;
	private current: AudioBufferSourceNode | null = null;

	async play(render: TtsRender, opts?: { signal?: AbortSignal }): Promise<void> {
		this.ctx ??= new AudioContext();
		await this.ctx.resume();
		for (const segment of render.segments) {
			if (opts?.signal?.aborted || !this.ctx) return;
			const buffer = this.ctx.createBuffer(1, segment.samples.length, segment.sampleRate);
			buffer.getChannelData(0).set(segment.samples);
			await new Promise<void>((resolve) => {
				if (!this.ctx) return resolve();
				const source = this.ctx.createBufferSource();
				source.buffer = buffer;
				source.connect(this.ctx.destination);
				this.current = source;
				source.onended = () => resolve();
				source.start();
			});
		}
	}

	stop(): void {
		this.current?.stop();
		this.current = null;
	}
}

export function splitSentences(text: string): string[] {
	const parts = text
		.split(/(?<=[.!?;:])\s+/)
		.map((s) => s.trim())
		.filter(Boolean);
	return parts.length ? parts : text.trim() ? [text.trim()] : [];
}
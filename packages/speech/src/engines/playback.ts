/**
 * Shared playback + text helpers for TTS engines. Extracted from kokoroTts
 * so piper (and future engines) stream sentences through one AudioContext.
 */

import { SpeechEngineError, type TtsRender, type TtsRenderSegment, type TtsSpeakOpts } from '../types.js';

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

/**
 * Speak sentence by sentence with one sentence of lookahead: the first plays
 * as soon as it is rendered, and sentence i+1 renders while i plays, so a
 * paragraph starts after one sentence's render instead of the whole text's.
 */
export async function streamSentences(
	text: string,
	render: (sentence: string) => Promise<TtsRenderSegment>,
	player: SegmentPlayer,
	opts?: Pick<TtsSpeakOpts, 'signal' | 'onProgress'>
): Promise<void> {
	const sentences = splitSentences(text);
	const segmentCount = sentences.length;
	const start = (i: number): Promise<TtsRenderSegment> => {
		const pending = render(sentences[i]!);
		// Settled later by the loop, or dropped on stop — never unhandled.
		pending.catch(() => {});
		return pending;
	};
	let next = segmentCount ? start(0) : null;
	for (let i = 0; next; i++) {
		const text = sentences[i]!;
		opts?.onProgress?.({ phase: 'rendering', text, segmentIndex: i, segmentCount });
		const segment = await next;
		if (opts?.signal?.aborted) throw new SpeechEngineError('CANCELLED', 'Speech stopped');
		next = i + 1 < segmentCount ? start(i + 1) : null;
		opts?.onProgress?.({ phase: 'playing', text, segmentIndex: i, segmentCount });
		await player.play({ segments: [segment], channels: 1 }, { signal: opts?.signal });
		if (opts?.signal?.aborted) throw new SpeechEngineError('CANCELLED', 'Speech stopped');
	}
}

export function splitSentences(text: string): string[] {
	const parts = text
		.split(/(?<=[.!?;:])\s+/)
		.map((s) => s.trim())
		.filter(Boolean);
	return parts.length ? parts : text.trim() ? [text.trim()] : [];
}
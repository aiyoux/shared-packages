/**
 * Minimal microphone capture via MediaRecorder — the MIME ladder and
 * mute-ramp follow `apps/voice-rec/src/lib/audioRecorder.ts`. Produces a
 * decodable container blob (webm/mp4/ogg) the caller decodes to PCM.
 */

export type MicRecorder = {
	start(): Promise<void>;
	/** Stop capture and resolve with the recorded container blob. */
	stop(): Promise<Blob>;
	/** Live input level 0..1 (RMS), polled by the UI. */
	level(): number;
};

export type MicMimeType = 'audio/webm;codecs=opus' | 'audio/webm' | 'audio/mp4' | 'audio/ogg;codecs=opus' | 'audio/ogg';

const MIME_LADDER: readonly MicMimeType[] = [
	'audio/webm;codecs=opus',
	'audio/webm',
	'audio/mp4',
	'audio/ogg;codecs=opus',
	'audio/ogg'
];

export function preferredMicMimeType(): MicMimeType | undefined {
	if (typeof MediaRecorder === 'undefined') return undefined;
	return MIME_LADDER.find((m) => MediaRecorder.isTypeSupported(m));
}

export async function createMicRecorder(): Promise<MicRecorder> {
	const stream = await navigator.mediaDevices.getUserMedia({
		audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true }
	});
	const mimeType = preferredMicMimeType();
	let recorder: MediaRecorder;
	try {
		recorder = mimeType ? new MediaRecorder(stream, { mimeType }) : new MediaRecorder(stream);
	} catch {
		recorder = new MediaRecorder(stream);
	}
	const chunks: Blob[] = [];
	recorder.ondataavailable = (e) => {
		if (e.data.size > 0) chunks.push(e.data);
	};

	// Mute-ramp the gain on start so the first captured frame has no pop.
	const ctx = new AudioContext();
	const source = ctx.createMediaStreamSource(stream);
	const gain = ctx.createGain();
	gain.gain.value = 0;
	source.connect(gain);
	gain.connect(ctx.destination);
	void ctx.resume().then(() => {
		gain.gain.linearRampToValueAtTime(1, ctx.currentTime + 0.15);
	});

	// Lightweight RMS meter for the UI's live level bar.
	const meterCtx = new AudioContext();
	const meterSource = meterCtx.createMediaStreamSource(stream);
	const analyser = meterCtx.createAnalyser();
	analyser.fftSize = 512;
	meterSource.connect(analyser);
	const levelBuf = new Float32Array(analyser.fftSize);

	return {
		start() {
			return new Promise((resolve, reject) => {
				recorder.onstart = () => resolve();
				recorder.onerror = () => reject(new Error('Recording failed to start'));
				recorder.start(1000);
			});
		},
		stop() {
			return new Promise<Blob>((resolve) => {
				recorder.onstop = () => {
					const blob = new Blob(chunks, { type: recorder.mimeType || mimeType || 'audio/webm' });
					for (const track of stream.getTracks()) track.stop();
					void ctx.close().catch(() => {});
					void meterCtx.close().catch(() => {});
					resolve(blob);
				};
				if (recorder.state !== 'inactive') recorder.stop();
				else recorder.onstop?.(new Event('stop'));
			});
		},
		level() {
			analyser.getFloatTimeDomainData(levelBuf);
			let sum = 0;
			for (let i = 0; i < levelBuf.length; i++) sum += levelBuf[i]! * levelBuf[i]!;
			return Math.sqrt(sum / levelBuf.length);
		}
	};
}
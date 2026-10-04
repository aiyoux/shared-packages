/**
 * Waveform drawing shared by Voice and the file preview: centred bars, and the
 * playhead with its time tag. Colours come from the caller, so each app keeps
 * its palette.
 */

export type PeakBarsStyle = {
	/** Bar width and gap in CSS pixels. */
	barWidth: number;
	gap: number;
	/** Bars left of `progress` (already played). */
	playedColor: string;
	/** Bars right of it. */
	restColor: string;
	/** Tallest bar as a share of the height (Voice uses 0.8). */
	scale?: number;
	/** Shortest bar, so silence still shows a line. */
	minHeight?: number;
};

/**
 * Fit `peaks` across `width`, one bar per slot, played part first.
 * `progress` is 0..1 of the whole.
 */
export function drawPeakBars(
	ctx: CanvasRenderingContext2D,
	width: number,
	height: number,
	peaks: ArrayLike<number>,
	progress: number,
	style: PeakBarsStyle
): void {
	const slot = style.barWidth + style.gap;
	const bars = Math.max(1, Math.floor(width / slot));
	const centerY = height / 2;
	const scale = style.scale ?? 0.8;
	const minH = style.minHeight ?? 2;
	const playedBars = Math.round(Math.max(0, Math.min(1, progress)) * bars);
	for (const [from, to, color] of [
		[0, playedBars, style.playedColor],
		[playedBars, bars, style.restColor]
	] as const) {
		ctx.beginPath();
		for (let i = from; i < to; i++) {
			const p = peaks.length ? peaks[Math.min(peaks.length - 1, Math.floor((i * peaks.length) / bars))]! : 0;
			const h = Math.max(minH, p * height * scale);
			ctx.rect(i * slot, centerY - h / 2, style.barWidth, h);
		}
		ctx.fillStyle = color;
		ctx.fill();
	}
}

export type PlayheadStyle = {
	color: string;
	textColor: string;
	font?: string;
};

/**
 * The playhead: a 2 px line at `x` and a rounded tag at the top holding
 * `label` (the time), kept inside the canvas.
 */
export function drawPlayheadHandle(
	ctx: CanvasRenderingContext2D,
	x: number,
	width: number,
	height: number,
	label: string,
	style: PlayheadStyle
): void {
	ctx.fillStyle = style.color;
	ctx.fillRect(x, 0, 2, height);

	ctx.font = style.font ?? 'bold 10px Inter, system-ui, sans-serif';
	const padding = 6;
	const handleW = ctx.measureText(label).width + padding * 2;
	const handleH = 18;
	const handleX = Math.max(0, Math.min(x - handleW / 2, width - handleW));
	const r = 4;
	ctx.beginPath();
	ctx.moveTo(handleX + r, 0);
	ctx.lineTo(handleX + handleW - r, 0);
	ctx.quadraticCurveTo(handleX + handleW, 0, handleX + handleW, r);
	ctx.lineTo(handleX + handleW, handleH - r);
	ctx.quadraticCurveTo(handleX + handleW, handleH, handleX + handleW - r, handleH);
	ctx.lineTo(handleX + r, handleH);
	ctx.quadraticCurveTo(handleX, handleH, handleX, handleH - r);
	ctx.lineTo(handleX, r);
	ctx.quadraticCurveTo(handleX, 0, handleX + r, 0);
	ctx.closePath();
	ctx.fill();

	ctx.fillStyle = style.textColor;
	ctx.textAlign = 'center';
	ctx.textBaseline = 'middle';
	ctx.fillText(label, handleX + handleW / 2, handleH / 2);
}

/** `m:ss`, or `h:mm:ss` from an hour. */
export function formatClock(seconds: number): string {
	const s = Math.max(0, Math.floor(Number.isFinite(seconds) ? seconds : 0));
	const h = Math.floor(s / 3600);
	const m = Math.floor((s % 3600) / 60);
	const ss = String(s % 60).padStart(2, '0');
	return h ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`;
}

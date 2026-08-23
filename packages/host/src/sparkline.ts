export const SPARKLINE_N = 60;

export function samplesToPoints(
	values: number[],
	width = 100,
	height = 24,
	max = 100
): string {
	if (values.length === 0) return '';
	const span = Math.max(values.length - 1, 1);
	return values
		.map((v, i) => {
			const x = (i / span) * width;
			const y = height - (Math.min(max, Math.max(0, v)) / max) * height;
			return `${x.toFixed(2)},${y.toFixed(2)}`;
		})
		.join(' ');
}

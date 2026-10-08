/** UniverSR windows bound model memory; overlap blends adjacent predictions. */
export const DEFAULT_AUDIO_CHUNK_SECONDS = 5;
export const DEFAULT_AUDIO_OVERLAP_SECONDS = 0.25;

export function audioChunkingError(chunk: number | undefined, overlap: number | undefined): string {
	if (chunk === undefined || !Number.isFinite(chunk) || chunk < 1 || chunk > 60) {
		return 'Choose a chunk duration between 1 and 60 seconds.';
	}
	if (overlap === undefined || !Number.isFinite(overlap) || overlap < 0 || overlap > 5 || overlap > chunk / 2) {
		return 'Overlap must be between 0 and 5 seconds and at most half the chunk duration.';
	}
	return '';
}

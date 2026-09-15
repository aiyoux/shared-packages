export type ScanQualityId = 'low' | 'medium' | 'high' | 'max';

export type ScanQualityPreset = {
	id: ScanQualityId;
	label: string;
	/** JPEG encoder quality, 0–1. */
	jpeg: number;
	/** Longest warped edge in pixels. */
	maxEdge: number;
};

export const SCAN_QUALITY_PRESETS: Record<ScanQualityId, ScanQualityPreset> = {
	low: { id: 'low', label: 'Low', jpeg: 0.55, maxEdge: 1000 },
	medium: { id: 'medium', label: 'Medium', jpeg: 0.75, maxEdge: 1400 },
	high: { id: 'high', label: 'High', jpeg: 0.92, maxEdge: 1600 },
	max: { id: 'max', label: 'Max', jpeg: 0.97, maxEdge: 2800 }
};

export const SCAN_QUALITY_ORDER: ScanQualityId[] = ['low', 'medium', 'high', 'max'];

export function scanQualityPreset(id: string | undefined): ScanQualityPreset {
	if (id && id in SCAN_QUALITY_PRESETS) return SCAN_QUALITY_PRESETS[id as ScanQualityId];
	return SCAN_QUALITY_PRESETS.high;
}

export type VideoInterpolatorStatus = {
	rifePath?: string;
};

export type VideoInterpolator = {
	checkStatus: () => Promise<VideoInterpolatorStatus>;
	newJobId: () => string;
	pollProgress: (id: string, onProgress: (n: number) => void) => () => void;
	interpolate: (blob: Blob, opts: { fps: number; id: string }) => Promise<Blob>;
};

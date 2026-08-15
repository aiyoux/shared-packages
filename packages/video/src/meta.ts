function finiteDuration(video: HTMLVideoElement): number | null {
	if (Number.isFinite(video.duration) && video.duration > 0) return video.duration;
	if (video.seekable.length > 0) {
		const end = video.seekable.end(video.seekable.length - 1);
		if (Number.isFinite(end) && end > 0) return end;
	}
	return null;
}

function revokeLater(url: string): void {
	setTimeout(() => {
		try {
			URL.revokeObjectURL(url);
		} catch {
			/* ignore */
		}
	}, 2000);
}

/** MediaRecorder WebM often reports `Infinity` until we seek past the last packet. */
export function getVideoDuration(blob: Blob): Promise<number> {
	return new Promise((resolve, reject) => {
		const video = document.createElement('video');
		video.preload = 'metadata';
		video.muted = true;
		video.playsInline = true;

		const url = URL.createObjectURL(blob);
		let settled = false;

		const finish = (err: Error | null, value?: number) => {
			if (settled) return;
			settled = true;
			revokeLater(url);
			if (err) reject(err);
			else resolve(value!);
		};

		const acceptIfKnown = (): boolean => {
			const d = finiteDuration(video);
			if (d == null) return false;
			finish(null, d);
			return true;
		};

		video.onloadedmetadata = () => {
			if (acceptIfKnown()) return;
			const onSeeked = () => {
				video.removeEventListener('seeked', onSeeked);
				video.removeEventListener('timeupdate', onSeeked);
				if (acceptIfKnown()) return;
				finish(new Error('Could not determine video duration'));
			};
			video.addEventListener('seeked', onSeeked);
			video.addEventListener('timeupdate', onSeeked);
			try {
				video.currentTime = 1e10;
			} catch {
				onSeeked();
			}
		};

		video.onerror = () => finish(new Error('Failed to load video metadata'));
		video.src = url;
	});
}

export function createVideoUrl(blob: Blob): string {
	return URL.createObjectURL(blob);
}

export function revokeVideoUrl(url: string, delayMs = 2000) {
	if (!url || !url.startsWith('blob:')) return;
	if (delayMs > 0) {
		setTimeout(() => {
			try {
				URL.revokeObjectURL(url);
			} catch {
				/* ignore */
			}
		}, delayMs);
	} else {
		try {
			URL.revokeObjectURL(url);
		} catch {
			/* ignore */
		}
	}
}

export function getVideoFrameRate(blob: Blob): Promise<number> {
	return new Promise((resolve) => {
		const video = document.createElement('video');
		video.preload = 'auto';
		video.muted = true;
		video.playsInline = true;
		const url = URL.createObjectURL(blob);
		video.src = url;

		const frameTimes: number[] = [];

		video.onloadeddata = () => {
			video.play().catch(() => {});

			const checkFrame = (_now: number, metadata: VideoFrameCallbackMetadata) => {
				frameTimes.push(metadata.mediaTime);
				if (frameTimes.length >= 5) {
					video.pause();
					setTimeout(() => {
						try {
							URL.revokeObjectURL(url);
						} catch {
							/* ignore */
						}
					}, 2000);
					const totalInterval = frameTimes[frameTimes.length - 1]! - frameTimes[0]!;
					const intervals = frameTimes.length - 1;
					if (totalInterval > 0) {
						resolve(Math.round(1 / (totalInterval / intervals)));
					} else {
						resolve(30);
					}
				} else {
					video.requestVideoFrameCallback(checkFrame);
				}
			};
			video.requestVideoFrameCallback(checkFrame);
		};

		video.onerror = () => {
			setTimeout(() => {
				try {
					URL.revokeObjectURL(url);
				} catch {
					/* ignore */
				}
			}, 2000);
			resolve(30);
		};
	});
}

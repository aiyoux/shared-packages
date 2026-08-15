export function getVideoDuration(blob: Blob): Promise<number> {
	return new Promise((resolve, reject) => {
		const video = document.createElement('video');
		video.preload = 'metadata';
		video.muted = true;
		video.playsInline = true;

		const url = URL.createObjectURL(blob);

		video.onloadedmetadata = () => {
			setTimeout(() => {
				try {
					URL.revokeObjectURL(url);
				} catch {
					/* ignore */
				}
			}, 2000);
			resolve(video.duration);
		};

		video.onerror = () => {
			setTimeout(() => {
				try {
					URL.revokeObjectURL(url);
				} catch {
					/* ignore */
				}
			}, 2000);
			reject(new Error('Failed to load video metadata'));
		};

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

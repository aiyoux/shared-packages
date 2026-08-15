<script lang="ts">
	import { onMount } from 'svelte';
	import Scissors from '@lucide/svelte/icons/scissors';
import Loader2 from '@lucide/svelte/icons/loader-2';
	import { processVideo } from './process.js';
	import type { VideoInterpolator } from './types.js';

	let {
		sourceBlob,
		trimStart,
		trimEnd,
		videoRef = null as HTMLVideoElement | null,
		interpolator = null as VideoInterpolator | null,
		onProcessStart,
		onProcessed,
		onError
	}: {
		sourceBlob: Blob | null;
		trimStart: number;
		trimEnd: number;
		videoRef?: HTMLVideoElement | null;
		/** Optional local interpolator (e.g. Language Hub RIFE bridge). */
		interpolator?: VideoInterpolator | null;
		/** Called when processing begins (page should clear prior output blobs). */
		onProcessStart?: () => void;
		onProcessed: (blob: Blob) => void;
		onError: (message: string) => void;
	} = $props();

	let useRife = $state(false);
	let rifeFps = $state(60);
	let rifeConnectionStatus = $state<'idle' | 'checking' | 'connected' | 'failed'>('idle');
	let rifeMessage = $state('');

	let exportWidth = $state<number | undefined>(undefined);
	let exportHeight = $state<number | undefined>(undefined);
	let exportBitrate = $state('1M');
	let selectedPreset = $state('original');

	let isProcessing = $state(false);
	let processingStep = $state('');
	let progress = $state(0);

	const sizePresets = [
		{
			label: 'Original',
			value: 'original',
			width: undefined as number | undefined,
			height: undefined as number | undefined
		},
		{ label: '1080p (1920×1080)', value: '1080p', width: 1920, height: 1080 },
		{ label: '720p (1280×720)', value: '720p', width: 1280, height: 720 },
		{ label: '480p (854×480)', value: '480p', width: 854, height: 480 },
		{ label: '360p (640×360)', value: '360p', width: 640, height: 360 },
		{ label: '240p (426×240)', value: '240p', width: 426, height: 240 }
	];

	async function checkRifeConnection() {
		rifeConnectionStatus = 'checking';
		rifeMessage = 'Checking...';
		try {
			if (!interpolator) {
				rifeConnectionStatus = 'failed';
				rifeMessage = 'No interpolator';
				return;
			}
			const data = await interpolator.checkStatus();
			rifeConnectionStatus = 'connected';
			rifeMessage = `RIFE connected! (Path: ${data.rifePath || 'rife-ncnn-vulkan'})`;
		} catch {
			rifeConnectionStatus = 'failed';
			rifeMessage = 'Offline';
		}
	}

	onMount(() => {
		if (interpolator) checkRifeConnection();
	});

	function applyPreset(value: string) {
		selectedPreset = value;
		const preset = sizePresets.find((p) => p.value === value);
		if (!preset) return;

		if (value === 'original') {
			exportWidth = undefined;
			exportHeight = undefined;
			return;
		}

		// Preserve aspect ratio from source video
		if (videoRef && videoRef.videoWidth && videoRef.videoHeight) {
			const sourceAspect = videoRef.videoWidth / videoRef.videoHeight;
			const presetAspect = preset.width! / preset.height!;

			if (sourceAspect > presetAspect) {
				exportWidth = preset.width;
				exportHeight = Math.round(preset.width! / sourceAspect);
			} else {
				exportHeight = preset.height;
				exportWidth = Math.round(preset.height! * sourceAspect);
			}
		} else {
			exportWidth = preset.width;
			exportHeight = preset.height;
		}
	}

	async function handleProcess() {
		if (!sourceBlob || isProcessing) return;
		onProcessStart?.();
		isProcessing = true;
		progress = 0;
		processingStep = 'Preparing...';

		try {
			processingStep = 'Trimming & Resizing video...';
			let result = await processVideo(sourceBlob, {
				start: trimStart,
				end: trimEnd,
				width: exportWidth,
				height: exportHeight,
				bitrate: exportBitrate,
				onProgress: (p) => {
					progress = useRife ? Math.round(p * 0.5) : p;
				}
			});

			if (useRife && interpolator) {
				processingStep = `Interpolating frames to ${rifeFps} FPS (RIFE)...`;
				progress = 50;
				const tempId = interpolator.newJobId();

				const stopPoll = interpolator.pollProgress(tempId, (n) => {
					progress = Math.round(50 + n * 0.5);
				});

				try {
					result = await interpolator.interpolate(result, { fps: rifeFps, id: tempId });
				} finally {
					stopPoll();
				}
			}

			progress = 100;
			processingStep = 'Complete!';
			onProcessed(result);
		} catch (err: any) {
			console.error('Processing failed:', err);
			onError(`Video processing failed: ${err.message}`);
			processingStep = 'Failed';
		} finally {
			isProcessing = false;
		}
	}
</script>

<!-- Export Settings -->
<div class="settings-section">
	<h3>Export Settings</h3>
	<div class="settings-grid">
		<div class="setting">
			<label for="preset">Size Preset</label>
			<select
				id="preset"
				value={selectedPreset}
				onchange={(e: Event) => applyPreset((e.currentTarget as HTMLSelectElement).value)}
			>
				{#each sizePresets as preset}
					<option value={preset.value}>{preset.label}</option>
				{/each}
			</select>
		</div>
		<div class="setting">
			<label for="width">Width (px)</label>
			<input id="width" type="number" min={1} bind:value={exportWidth} placeholder="Original" />
		</div>
		<div class="setting">
			<label for="height">Height (px)</label>
			<input id="height" type="number" min={1} bind:value={exportHeight} placeholder="Original" />
		</div>
		<div class="setting">
			<label for="bitrate">Bitrate</label>
			<select id="bitrate" bind:value={exportBitrate}>
				<option value="500k">500 kbps (small)</option>
				<option value="1M">1 Mbps (standard)</option>
				<option value="2M">2 Mbps (high)</option>
				<option value="4M">4 Mbps (very high)</option>
				<option value="8M">8 Mbps (lossy)</option>
			</select>
		</div>
	</div>
</div>

{#if interpolator}
<!-- RIFE Frame Interpolation (Local Bridge) -->
<div class="settings-section">
	<div class="settings-header-row">
		<h3>RIFE Frame Interpolation (Local Bridge)</h3>
		{#if rifeConnectionStatus !== 'idle'}
			<div class="rife-connection-badge rife-connection-{rifeConnectionStatus}">
				<span class="badge-dot"></span>
				<span>{rifeMessage}</span>
			</div>
		{/if}
	</div>
	<div class="rife-settings-card">
		<div class="rife-checkbox-container">
			<label class="checkbox-label">
				<input
					type="checkbox"
					bind:checked={useRife}
					disabled={rifeConnectionStatus !== 'connected'}
				/>
				<span>Interpolate frames with RIFE</span>
			</label>
			{#if rifeConnectionStatus !== 'connected'}
				<button type="button" class="btn btn-ghost btn-xs check-rife-btn" onclick={checkRifeConnection}>
					Retry Connection
				</button>
			{/if}
		</div>
		{#if useRife}
			<div class="settings-grid rife-options-grid animate-fade-in">
				<div class="setting">
					<label for="rifeFps">Output Framerate (FPS)</label>
					<select id="rifeFps" bind:value={rifeFps}>
						<option value={30}>30 FPS</option>
						<option value={60}>60 FPS (Recommended)</option>
						<option value={120}>120 FPS</option>
					</select>
				</div>
				<div class="setting">
					<label for="rifeFpsCustom">Custom FPS</label>
					<input id="rifeFpsCustom" type="number" min={1} max={240} bind:value={rifeFps} />
				</div>
			</div>
		{/if}
	</div>
</div>
{/if}

<!-- Actions -->
<div class="actions-section">
	<button
		class="btn btn-primary process-btn"
		onclick={handleProcess}
		disabled={isProcessing || !sourceBlob}
	>
		{#if isProcessing}
			<span class="spin-wrapper"><Loader2 size={18} /></span>
			Processing {progress}%
		{:else}
			<Scissors size={18} />
			Process Video
		{/if}
	</button>
	{#if isProcessing}
		<div class="progress-bar">
			<div class="progress-fill" style="width: {progress}%"></div>
		</div>
		{#if processingStep}
			<span class="processing-step-text">{processingStep}</span>
		{/if}
	{/if}
</div>

<style>
	.settings-section h3 {
		font-size: 1rem;
		color: var(--text-secondary);
		margin: 0 0 12px 0;
	}

	.settings-grid {
		display: grid;
		grid-template-columns: repeat(4, 1fr);
		gap: 16px;
	}

	.setting {
		display: flex;
		flex-direction: column;
		gap: 6px;
	}

	.setting label {
		font-size: 0.85rem;
		font-weight: 500;
		color: var(--text-secondary);
	}

	.setting input,
	.setting select {
		background: rgba(255, 255, 255, 0.05);
		border: 1px solid var(--border);
		border-radius: var(--radius-md);
		padding: 10px 12px;
		color: var(--text-primary);
		font-family: inherit;
		outline: none;
		font-size: 0.95rem;
		transition: border-color var(--transition-fast) var(--ease-default);
	}

	.setting input:focus,
	.setting select:focus {
		border-color: var(--accent);
	}

	.actions-section {
		display: flex;
		flex-direction: column;
		gap: 12px;
		align-items: flex-start;
	}

	.process-btn {
		display: flex;
		align-items: center;
		gap: 8px;
		min-width: 180px;
		justify-content: center;
	}

	.process-btn:disabled {
		opacity: 0.6;
		cursor: not-allowed;
	}

	.progress-bar {
		width: 100%;
		height: 6px;
		background: rgba(255, 255, 255, 0.1);
		border-radius: var(--radius-full);
		overflow: hidden;
	}

	.progress-fill {
		height: 100%;
		background: var(--accent);
		border-radius: var(--radius-full);
		transition: width 0.2s ease;
	}

	.spin-wrapper {
		display: inline-flex;
		animation: spin 1s linear infinite;
	}

	@keyframes spin {
		from {
			transform: rotate(0deg);
		}
		to {
			transform: rotate(360deg);
		}
	}

	@media (max-width: 600px) {
		.settings-grid {
			grid-template-columns: 1fr;
		}
	}

	.settings-header-row {
		display: flex;
		justify-content: space-between;
		align-items: center;
		margin-bottom: 12px;
		flex-wrap: wrap;
		gap: 8px;
	}

	.settings-header-row h3 {
		margin: 0 !important;
	}

	.rife-connection-badge {
		display: inline-flex;
		align-items: center;
		gap: 6px;
		font-size: 0.8rem;
		padding: 3px 8px;
		border-radius: var(--radius-sm);
		border: 1px solid var(--border);
		background: rgba(255, 255, 255, 0.02);
		font-family: monospace;
	}

	.badge-dot {
		width: 6px;
		height: 6px;
		border-radius: 50%;
		display: inline-block;
	}

	.rife-connection-checking {
		border-color: rgba(255, 193, 7, 0.2);
		background: rgba(255, 193, 7, 0.05);
		color: #ffc107;
	}
	.rife-connection-checking .badge-dot {
		background: #ffc107;
		animation: pulse-badge 1.5s infinite;
	}

	.rife-connection-connected {
		border-color: rgba(16, 185, 129, 0.2);
		background: rgba(16, 185, 129, 0.05);
		color: #10b981;
	}
	.rife-connection-connected .badge-dot {
		background: #10b981;
	}

	.rife-connection-failed {
		border-color: rgba(239, 68, 68, 0.2);
		background: rgba(239, 68, 68, 0.05);
		color: #ef4444;
	}
	.rife-connection-failed .badge-dot {
		background: #ef4444;
	}

	.rife-settings-card {
		background: rgba(255, 255, 255, 0.02);
		border: 1px solid var(--border);
		border-radius: var(--radius-lg);
		padding: 16px;
		display: flex;
		flex-direction: column;
		gap: 16px;
	}

	.rife-checkbox-container {
		display: flex;
		justify-content: space-between;
		align-items: center;
		flex-wrap: wrap;
		gap: 8px;
	}

	.check-rife-btn {
		padding: 2px 8px;
		font-size: 0.75rem;
		height: 24px;
		background: rgba(255, 255, 255, 0.05);
		border: 1px solid var(--border);
		border-radius: var(--radius-sm);
		color: var(--text-secondary);
		cursor: pointer;
		transition: all var(--transition-fast) var(--ease-default);
	}

	.check-rife-btn:hover {
		background: rgba(255, 255, 255, 0.1);
		color: var(--text-primary);
		border-color: var(--accent);
	}

	.rife-options-grid {
		border-top: 1px dashed var(--border);
		padding-top: 16px;
		margin-top: 4px;
		grid-template-columns: repeat(2, 1fr) !important;
	}

	.processing-step-text {
		font-size: 0.85rem;
		color: var(--accent-light);
		margin-top: 6px;
		text-align: center;
		display: block;
		font-weight: 500;
	}

	@keyframes pulse-badge {
		0% {
			opacity: 0.4;
		}
		50% {
			opacity: 1;
		}
		100% {
			opacity: 0.4;
		}
	}
</style>

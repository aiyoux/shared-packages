import { describe, expect, it, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/svelte';
import VideoProcessPanel from '../src/VideoProcessPanel.svelte';

vi.mock('../src/process.js', () => ({ processVideo: vi.fn(async (blob: Blob) => blob) }));

describe('UniverSR chunk controls in video processing', () => {
	it('forwards edited chunk settings and blocks an invalid overlap', async () => {
		const source = new Blob(['video']);
		const upsample = vi.fn(async () => new Blob(['enhanced']));
		const onProcessed = vi.fn();
		render(VideoProcessPanel, {
			sourceBlob: source, trimStart: 0, trimEnd: 5, onProcessed, onError: vi.fn(),
			audioUpscaler: {
				checkStatus: async () => ({ audioPath: 'Monitor', defaultEngine: 'monitor:desktop:universr', engines: [{ id: 'monitor:desktop:universr', label: 'UniverSR' }] }),
				newJobId: () => 'chunk-job', pollProgress: () => () => {}, upsample
			}
		});
		const enable = screen.getByLabelText('Upsample audio to 48 kHz');
		await waitFor(() => expect((enable as HTMLInputElement).disabled).toBe(false));
		await fireEvent.click(enable);
		const chunk = screen.getByLabelText('Chunk duration (seconds)');
		const overlap = screen.getByLabelText('Overlap (seconds)');
		expect((chunk as HTMLInputElement).value).toBe('5');
		expect((overlap as HTMLInputElement).value).toBe('0.25');
		await fireEvent.input(chunk, { target: { value: '2.5' } });
		await fireEvent.input(overlap, { target: { value: '2' } });
		expect(screen.getByRole('alert').textContent).toContain('at most half');
		const process = screen.getByRole('button', { name: 'Process Video' });
		expect((process as HTMLButtonElement).disabled).toBe(true);
		expect(upsample).not.toHaveBeenCalled();
		await fireEvent.input(overlap, { target: { value: '0.1' } });
		await fireEvent.click(process);
		await waitFor(() => expect(onProcessed).toHaveBeenCalledOnce());
		expect(upsample).toHaveBeenCalledWith(source, {
			engine: 'monitor:desktop:universr', denoise: false,
			chunkSeconds: 2.5, overlapSeconds: 0.1, id: 'chunk-job'
		});
	});
});

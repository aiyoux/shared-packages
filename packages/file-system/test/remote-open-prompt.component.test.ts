import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/svelte';
import RemoteOpenPrompt from '../src/ui/RemoteOpenPrompt.svelte';
import type { RemoteOpenPlan } from '../src/services/remoteCopies.js';

afterEach(cleanup);

const base: RemoteOpenPlan = { name: 'clip.mov', label: 'Office PC', size: 350 * 1024 * 1024, action: 'copy', ask: true };

describe('remote open prompt', () => {
	it('says how big and how slow the copy is, and that Save sends it back', async () => {
		const onCopy = vi.fn();
		render(RemoteOpenPrompt, { props: { plan: { ...base, copyMs: 150_000 }, onCopy, onCancel: vi.fn() } });
		expect(screen.getByRole('dialog').textContent).toContain('Copy clip.mov to this device?');
		expect(screen.getByTestId('fe-remote-open-time').textContent).toBe('about 3 min on this connection');
		expect(screen.getByRole('dialog').textContent).toContain('Each Save sends it back to Office PC');
		await fireEvent.click(screen.getByTestId('fe-remote-open-copy'));
		expect(onCopy).toHaveBeenCalledOnce();
	});

	it('says when the speed is not known yet', () => {
		render(RemoteOpenPrompt, { props: { plan: base, onCopy: vi.fn(), onCancel: vi.fn() } });
		expect(screen.getByTestId('fe-remote-open-time').textContent).toContain('not been measured yet');
	});

	it('offers another way to open it as its own button', async () => {
		const onAlternative = vi.fn();
		render(RemoteOpenPrompt, {
			props: {
				plan: { ...base, name: 'Notes.kb', ask: false },
				alternatives: [{ id: 'live', label: 'Open live on Office PC', detail: 'Open live: edits go to Office PC as you type.' }],
				onCopy: vi.fn(),
				onCancel: vi.fn(),
				onAlternative
			}
		});
		expect(screen.getByRole('dialog').textContent).toContain('Open Notes.kb');
		await fireEvent.click(screen.getByTestId('fe-remote-open-alt-live'));
		expect(onAlternative).toHaveBeenCalledWith('live');
	});

	it('a blocked file explains why and only closes', async () => {
		const onCancel = vi.fn();
		render(RemoteOpenPrompt, {
			props: { plan: { ...base, blocked: 'Too many pixels.' }, onCopy: vi.fn(), onCancel }
		});
		expect(screen.getByTestId('fe-remote-open-blocked').textContent).toBe('Too many pixels.');
		expect(screen.queryByTestId('fe-remote-open-copy')).toBeNull();
		await fireEvent.click(screen.getByTestId('fe-remote-open-cancel'));
		expect(onCancel).toHaveBeenCalledOnce();
	});

	it('Escape cancels', async () => {
		const onCancel = vi.fn();
		render(RemoteOpenPrompt, { props: { plan: base, onCopy: vi.fn(), onCancel } });
		await fireEvent.keyDown(window, { key: 'Escape' });
		expect(onCancel).toHaveBeenCalledOnce();
	});
});

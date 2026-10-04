import { describe, it, expect, beforeEach, beforeAll, afterAll } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/svelte';
import { resetSharedVfsForTests } from '../src/index.ts';
import OverlayOwnershipHarness from './OverlayOwnershipHarness.svelte';

beforeEach(() => resetSharedVfsForTests());
const animate = HTMLElement.prototype.animate;
beforeAll(() => {
	// jsdom has no Web Animations API. Finish Svelte's dialog transitions so
	// these ownership assertions also verify destruction after an outro.
	HTMLElement.prototype.animate = (() => {
		let cancelled = false;
		const animation = { currentTime: 0, playState: 'finished', onfinish: null as (() => void) | null, cancel() { cancelled = true; }, effect: null };
		queueMicrotask(() => { if (!cancelled) animation.onfinish?.(); });
		return animation;
	}) as unknown as typeof HTMLElement.prototype.animate;
});
afterAll(() => { HTMLElement.prototype.animate = animate; });
async function escape() {
	await fireEvent.keyDown(document.activeElement ?? document.body, { key: 'Escape' });
}

describe('overlay ownership across shared components', () => {
	it('an inline Svelte edit consumes Escape before the containing Dialog', async () => {
		render(OverlayOwnershipHarness);
		const input = screen.getByTestId('inline-edit');
		input.focus();
		await escape();
		expect(screen.queryByTestId('inline-edit')).toBeNull();
		expect(screen.getByRole('dialog')).toBeTruthy();
		await escape();
		await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
	});
	it('nested Popovers close one at a time, restore their triggers and leave Dialog open', async () => {
		render(OverlayOwnershipHarness);
		await fireEvent.click(screen.getByTestId('popup-trigger'));
		await fireEvent.click(await screen.findByTestId('nested-trigger'));
		await screen.findByTestId('nested-action');
		await escape();
		await waitFor(() => expect(screen.queryByTestId('nested-action')).toBeNull());
		expect(screen.getByTestId('nested-trigger')).toBe(document.activeElement);
		expect(screen.getByRole('dialog')).toBeTruthy();
		await escape();
		await waitFor(() => expect(screen.queryByTestId('nested-trigger')).toBeNull());
		expect(screen.getByTestId('popup-trigger')).toBe(document.activeElement);
		await escape();
		await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
		expect(document.body.style.overflow).toBe('');
	});
	it('Files confirmation consumes Escape while the file picker stays open', async () => {
		render(OverlayOwnershipHarness, { picker: true });
		await screen.findByTestId('vfs-dialog');
		await fireEvent.click(screen.getByTestId('confirm-trigger'));
		await screen.findByTestId('fe-confirm-dialog');
		await escape();
		await waitFor(() => expect(screen.queryByTestId('fe-confirm-dialog')).toBeNull());
		expect(screen.getByTestId('vfs-dialog')).toBeTruthy();
		await fireEvent.keyDown(document.body, { key: 'Escape' });
		await waitFor(() => expect(screen.queryByTestId('vfs-dialog')).toBeNull());
	});
});

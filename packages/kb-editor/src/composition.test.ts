import { createEmptyPage, plaintextOf } from '@shared-packages/kb-model';
import { describe, expect, it, vi } from 'vitest';
import { mapBeforeInput } from './beforeinput.js';
import {
	beginComposition,
	cancelComposition,
	commitComposition,
	shouldProject,
	snapshotComposition
} from './composition.js';
import { project, syncView } from './project.js';
import { createEditorState, dispatchMany } from './state.js';
import { para, page } from './testFixtures.js';

describe('composition state machine (IME freeze)', () => {
	it('composing flag freezes projection — project is not called while composing', () => {
		const host = document.createElement('div');
		document.body.append(host);
		const state = {
			...createEditorState(page([para('p', 'hi')])),
			composing: true
		};
		const spy = vi.spyOn(host, 'replaceChildren');
		syncView(host, state);
		expect(spy).not.toHaveBeenCalled();
		expect(shouldProject(state)).toBe(false);
		expect(host.childNodes.length).toBe(0);
		spy.mockRestore();
		host.remove();
	});

	it('does not preventDefault any beforeinput while composing, including insertParagraph', () => {
		const state = beginComposition(createEditorState(page([para('p', '')])));
		for (const inputType of [
			'insertText',
			'insertCompositionText',
			'insertParagraph',
			'insertLineBreak',
			'insertReplacementText',
			'insertFromPaste',
			'insertFromDrop',
			'deleteContentBackward'
		]) {
			const result = mapBeforeInput(
				state,
				{ inputType, data: 'x', isComposing: true },
				state.selection
			);
			expect(result.preventDefault, inputType).toBe(false);
			expect(result.ops, inputType).toEqual([]);
			expect(result.freeze, inputType).toBe(true);
		}
	});

	it('compositionstart with a non-empty selection does not dispatch delete-range', () => {
		const base = createEditorState(page([para('p', 'abc')]));
		const selected = {
			...base,
			selection: { anchor: { blockId: 'p', offset: 0 }, head: { blockId: 'p', offset: 3 } }
		};
		const snap = snapshotComposition(selected, selected.selection);
		const next = beginComposition(selected);
		expect(next.composing).toBe(true);
		expect(plaintextOf(next.page.blocks[0])).toBe('abc');
		expect(snap.selection).toEqual(selected.selection);
	});

	it('cancelled composition (Esc / empty data) does not insert and allows re-project of the snapshot', () => {
		const host = document.createElement('div');
		document.body.append(host);
		let state = createEditorState(page([para('p', 'ok')]));
		project(host, state.page);
		state = beginComposition(state);
		expect(shouldProject(state)).toBe(false);
		state = cancelComposition(state);
		expect(state.composing).toBe(false);
		expect(state.justCommittedComposition).toBe(false);
		syncView(host, state);
		expect(host.querySelector('[data-block-id="p"]')?.textContent).toBe('ok');
		host.remove();
	});

	it('compositionend commits one insert-text then re-projects', () => {
		const state = beginComposition(createEditorState(page([para('p', '')])));
		const snap = snapshotComposition(state, state.selection);
		const { ops, state: ended } = commitComposition(state, snap, 'あ');
		expect(ended.composing).toBe(false);
		expect(ended.justCommittedComposition).toBe(true);
		expect(ops).toEqual([{ kind: 'insert-text', at: { blockId: 'p', offset: 0 }, text: 'あ' }]);
		const next = dispatchMany({ ...state, composing: false }, ops);
		expect(plaintextOf(next.page.blocks[0])).toBe('あ');
	});

	it('justCommittedComposition swallows follow-up insertParagraph (CJK Enter confirm)', () => {
		const state = {
			...createEditorState(page([para('p', 'あ')])),
			justCommittedComposition: true
		};
		const paraResult = mapBeforeInput(
			state,
			{ inputType: 'insertParagraph', data: null },
			state.selection
		);
		expect(paraResult.preventDefault).toBe(true);
		expect(paraResult.ops).toEqual([]);
		const textResult = mapBeforeInput(state, { inputType: 'insertText', data: 'あ' }, state.selection);
		expect(textResult.ops).toEqual([]);
		const br = mapBeforeInput(state, { inputType: 'insertLineBreak', data: null }, state.selection);
		expect(br.ops).toEqual([]);
	});

	/**
	 * Documented PR-3 compositionend → insertParagraph swallow.
	 * This package has no Playwright runner (none in shared-packages). Hub e2e owns Chromium CJK
	 * (preedit visible in the text node). This test is the in-package stand-in: commit once, then a
	 * follow-up insertParagraph with isComposing=false must not split.
	 */
	it('compositionend then insertParagraph does not extra-split (Chromium CJK stand-in)', () => {
		let state = beginComposition(createEditorState(page([para('p', '')])));
		const snap = snapshotComposition(state, state.selection);
		const { ops, state: ended } = commitComposition(state, snap, '漢字');
		state = dispatchMany({ ...ended, composing: false }, ops);
		expect(plaintextOf(state.page.blocks[0])).toBe('漢字');
		expect(state.page.blocks).toHaveLength(1);
		const follow = mapBeforeInput(
			{ ...state, justCommittedComposition: true },
			{ inputType: 'insertParagraph', data: null, isComposing: false },
			state.selection
		);
		expect(follow.ops).toEqual([]);
		expect(follow.preventDefault).toBe(true);
	});

	it('never preventDefaults insertCompositionText even when not composing', () => {
		const state = createEditorState(createEmptyPage({ id: 'pg', title: '' }));
		const result = mapBeforeInput(
			state,
			{ inputType: 'insertCompositionText', data: 'か' },
			state.selection
		);
		expect(result.preventDefault).toBe(false);
		expect(result.ops).toEqual([]);
		expect(result.freeze).toBe(true);
	});
});

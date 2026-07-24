import { describe, expect, it } from 'vitest';
import { DateAnchorEditorState } from './DateAnchorEditorState.svelte.ts';

describe('DateAnchorEditorState', () => {
  it('clears every end-side reference when explicit end is disabled', () => {
    const editor = new DateAnchorEditorState({
      is_status: false,
      value: {
        d: {
          s: { type: 'of', v: 0, a: 'up' },
          e: { type: 'of', v: 0, a: 'up' }
        },
        i: {
          s: { type: 'vg', t: 'mo' },
          e: { type: 'vg', t: 'mo' }
        }
      }
    });

    editor.setHasExplicitEnd(false);

    expect(editor.draft.value.d?.s).toEqual({ type: 'of', v: 0, a: 'up' });
    expect(editor.draft.value.d?.e).toBeUndefined();
    expect(editor.draft.value.i?.s).toEqual({ type: 'vg', t: 'mo' });
    expect(editor.draft.value.i?.e).toBeUndefined();
    expect(editor.hasExplicitEndBoundary).toBe(false);
  });

  it('treats week end refs as explicit ends when clearing', () => {
    const editor = new DateAnchorEditorState({
      is_status: false,
      value: {
        y: { s: { type: 'ba', v: 2026 } },
        w: {
          s: { type: 'ba', v: 12 },
          e: { type: 'ba', v: 13 }
        }
      }
    });

    expect(editor.hasExplicitEndBoundary).toBe(true);
    editor.setHasExplicitEnd(false);

    expect(editor.draft.value.y?.s).toEqual({ type: 'ba', v: 2026 });
    expect(editor.draft.value.w?.s).toEqual({ type: 'ba', v: 12 });
    expect(editor.draft.value.w?.e).toBeUndefined();
    expect(editor.hasExplicitEndBoundary).toBe(false);
  });

  it('detects week offset anchors', () => {
    const editor = new DateAnchorEditorState({
      is_status: false,
      value: {
        w: { s: { type: 'of', v: 1, a: 'pr' } }
      }
    });

    expect(editor.anchorType).toBe('pr');
  });

  it('exposes week refs through date picker values', () => {
    const editor = new DateAnchorEditorState({
      is_status: false,
      value: {
        y: { s: { type: 'ba', v: 2026 }, e: { type: 'ba', v: 2026 } },
        w: { s: { type: 'ba', v: 12 }, e: { type: 'ba', v: 13 } },
        wm: 'iso'
      }
    });

    expect(editor.startDatePickerValue.w).toEqual({ type: 'ba', v: 12 });
    expect(editor.startDatePickerValue.wm).toBe('iso');
    expect(editor.endDatePickerValue.w).toEqual({ type: 'ba', v: 13 });
    expect(editor.endDatePickerValue.wm).toBe('iso');
  });

  it('adds end-side references from the start side when explicit end is enabled', () => {
    const editor = new DateAnchorEditorState({
      is_status: false,
      value: {
        d: { s: { type: 'of', v: 0, a: 'up' } },
        i: { s: { type: 'vg', t: 'mo' } }
      }
    });

    editor.setHasExplicitEnd(true);

    expect(editor.draft.value.d?.e).toEqual({ type: 'of', v: 0, a: 'up' });
    expect(editor.draft.value.i?.e).toEqual({ type: 'vg', t: 'mo' });
    expect(editor.hasExplicitEndBoundary).toBe(true);
  });

  it('preserves a canonical relevance window through the draft clone', () => {
    const window = {
      before: { type: 'cal', unit: 'week' as const },
      after: { type: 'dur', minutes: 120 }
    };
    const editor = new DateAnchorEditorState({
      is: false,
      value: { d: { s: { type: 'of', v: 0, a: 'up' } } },
      rl: window
    });

    expect(editor.draft.rl).toEqual(window);
    // Cloned, not aliased — editing the draft must not mutate the input.
    expect(editor.draft.rl).not.toBe(window);
  });

  // Folding legacy rv/ri scalars into rl is canonicalizeDateInformation's job
  // (see date/relevance.test.ts), not this editor's — it clones canonical
  // short-form input (is/ds/rl/po) as-is and does not resurrect long fields.
});

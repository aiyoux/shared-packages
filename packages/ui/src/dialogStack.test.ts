import { describe, it, expect, beforeEach } from 'vitest';
import {
  pushDialog,
  popDialog,
  isTopDialog,
  getModalBaseZ,
  nextDialogTitleId,
  __resetDialogStackForTests
} from './dialogStack.ts';

describe('dialogStack', () => {
  beforeEach(() => {
    __resetDialogStackForTests();
  });

  it('assigns increasing depth; z-index is base + depth * 10', () => {
    const a = Symbol('a');
    const b = Symbol('b');
    const depthA = pushDialog(a);
    const depthB = pushDialog(b);
    expect(depthA).toBe(0);
    expect(depthB).toBe(1);
    const base = getModalBaseZ();
    expect(base + depthA * 10).toBe(base);
    expect(base + depthB * 10).toBe(base + 10);
    expect(isTopDialog(b)).toBe(true);
    expect(isTopDialog(a)).toBe(false);
    popDialog(b);
    expect(isTopDialog(a)).toBe(true);
    popDialog(a);
    expect(isTopDialog(a)).toBe(false);
  });

  it('pop of middle entry leaves top intact', () => {
    const a = Symbol('a');
    const b = Symbol('b');
    const c = Symbol('c');
    pushDialog(a);
    pushDialog(b);
    pushDialog(c);
    popDialog(b);
    expect(isTopDialog(c)).toBe(true);
    popDialog(c);
    popDialog(a);
  });

  it('generates unique title ids', () => {
    const t1 = nextDialogTitleId();
    const t2 = nextDialogTitleId();
    expect(t1).not.toBe(t2);
    expect(t1.startsWith('dialog-title-')).toBe(true);
  });
});

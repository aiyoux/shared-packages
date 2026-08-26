import { describe, expect, it, vi } from 'vitest';
import { confirmDiscardUnsaved } from './unsaved.js';

describe('confirmDiscardUnsaved', () => {
	it('returns true when clean', () => {
		expect(confirmDiscardUnsaved(false)).toBe(true);
	});

	it('prompts and respects cancel when dirty', () => {
		const confirm = vi.fn(() => false);
		expect(confirmDiscardUnsaved(true, 'Discard?', confirm)).toBe(false);
		expect(confirm).toHaveBeenCalledWith('Discard?');
	});
});

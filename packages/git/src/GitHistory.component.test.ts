import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/svelte';
import GitHistory from './GitHistory.svelte';

describe('GitHistory', () => {
	it('renders empty state when no snapshot', () => {
		render(GitHistory, { props: { snapshot: null } });
		expect(screen.getByTestId('git-history')).toBeTruthy();
		expect(screen.getByTestId('git-history-empty').textContent).toMatch(/No repository selected/);
		expect(screen.queryByTestId('git-init-repo')).toBeNull();
	});

	it('offers Initialize repository when onInit is provided', async () => {
		const onInit = vi.fn();
		render(GitHistory, { props: { snapshot: null, onInit } });
		const btn = screen.getByTestId('git-init-repo');
		expect(btn.textContent).toMatch(/Initialize repository/);
		await fireEvent.click(btn);
		expect(onInit).toHaveBeenCalledTimes(1);
	});

	it('says loading when a repo is selected but snapshot has not arrived', () => {
		render(GitHistory, {
			props: {
				repoId: 'pending',
				gitHost: {
					snapshot: () => new Promise(() => {}),
					subscribe: () => () => {}
				} as never
			}
		});
		expect(screen.getByTestId('git-history-empty').textContent).toMatch(/Loading/);
	});

	it('renders branch, dirty, and commits', () => {
		render(GitHistory, {
			props: {
				snapshot: {
					status: { branch: 'main', dirty: true },
					log: [{ sha: 'abcdef123456', subject: 'hello' }],
					changes: []
				}
			}
		});
		expect(screen.getByTestId('git-history-branch').textContent).toMatch(/main/);
		expect(screen.getByTestId('git-history-dirty')).toBeTruthy();
		expect(screen.getByTestId('git-history-commit').textContent).toMatch(/abcdef1/);
		expect(screen.getByTestId('git-history-commit').textContent).toMatch(/hello/);
	});

	it('shows a read failure as an error, never as "No commits"', async () => {
		render(GitHistory, {
			props: {
				repoId: 'broken',
				gitHost: {
					snapshot: () => Promise.reject(new Error('Could not find HEAD')),
					subscribe: () => () => {}
				} as never
			}
		});
		const err = await screen.findByTestId('git-history-error');
		expect(err.textContent).toMatch(/Could not find HEAD/);
		expect(screen.queryByText('No commits')).toBeNull();
	});

	it('keeps the last snapshot when subscribe emits an error', async () => {
		render(GitHistory, {
			props: {
				repoId: 'live',
				gitHost: {
					snapshot: () =>
						Promise.resolve({
							status: { branch: 'main', dirty: false },
							log: [{ sha: 'abcdef123456', subject: 'hello' }],
							changes: []
						}),
					subscribe: (
						_id: string,
						onChange: (s: unknown) => void,
						onError?: (e: unknown) => void
					) => {
						onChange({
							status: { branch: 'main', dirty: false },
							log: [{ sha: 'abcdef123456', subject: 'hello' }],
							changes: []
						});
						queueMicrotask(() => onError?.(new Error('WRITE_IN_FLIGHT')));
						return () => {};
					}
				} as never
			}
		});
		const err = await screen.findByTestId('git-history-error');
		expect(err.textContent).toMatch(/WRITE_IN_FLIGHT/);
		expect(screen.getByTestId('git-history-commit').textContent).toMatch(/hello/);
	});

	describe('per-file diff and line selection', () => {
		// A successful commit persists the author identity to localStorage
		// (by design — see loadAuthor), which would otherwise hide the "who"
		// fields the next test expects to fill in.
		beforeEach(() => localStorage.clear());

		function commitHost(commit = vi.fn().mockResolvedValue('deadbeef')) {
			return {
				snapshot: () =>
					Promise.resolve({
						status: { branch: 'main', dirty: true },
						log: [],
						changes: [{ path: 'm.txt', status: 'modified' as const }]
					}),
				subscribe: () => () => {},
				diffFile: vi.fn().mockResolvedValue({
					oldText: 'a\nb\nc\n',
					newText: 'a\nB\nc\nd\n',
					diff: {
						kind: 'text',
						hunks: [
							{
								oldStart: 1,
								oldLines: 3,
								newStart: 1,
								newLines: 4,
								lines: [
									{ kind: 'ctx', text: 'a', oldNo: 1, newNo: 1, opIndex: 0 },
									{ kind: 'del', text: 'b', oldNo: 2, newNo: null, opIndex: 1 },
									{ kind: 'add', text: 'B', oldNo: null, newNo: 2, opIndex: 2 },
									{ kind: 'ctx', text: 'c', oldNo: 3, newNo: 3, opIndex: 3 },
									{ kind: 'add', text: 'd', oldNo: null, newNo: 4, opIndex: 4 }
								]
							}
						]
					}
				}),
				commit
			};
		}

		it('clicking the file name expands and fetches the diff', async () => {
			const host = commitHost();
			render(GitHistory, { props: { repoId: 'r', gitHost: host as never } });
			const nameBtn = await screen.findByTestId('git-change-expand-m.txt');
			await fireEvent.click(nameBtn);
			expect(host.diffFile).toHaveBeenCalledWith('r', 'm.txt');
			const view = await screen.findByTestId('git-diff-view');
			expect(view.textContent).toContain('B');
			expect(view.textContent).toContain('d');
		});

		it('deselecting an added line shows a partial badge and leaves it out of the commit', async () => {
			const commit = vi.fn().mockResolvedValue('deadbeef');
			const host = commitHost(commit);
			render(GitHistory, { props: { repoId: 'r', gitHost: host as never } });
			await fireEvent.click(await screen.findByTestId('git-change-expand-m.txt'));
			const lineChecks = await screen.findAllByTestId('git-diff-line-check');
			// lines, in order: del "b" (2 -> null), add "B", add "d" — deselect "d".
			await fireEvent.click(lineChecks[2]!);
			expect(await screen.findByTestId('git-change-partial-m.txt')).toBeTruthy();

			await fireEvent.input(screen.getByTestId('git-commit-message'), { target: { value: 'msg' } });
			await fireEvent.input(screen.getByTestId('git-author-name'), { target: { value: 'T' } });
			await fireEvent.input(screen.getByTestId('git-author-email'), { target: { value: 't@t.test' } });
			await fireEvent.click(screen.getByTestId('git-commit-btn'));

			await vi.waitFor(() => expect(commit).toHaveBeenCalled());
			const opts = commit.mock.calls[0]![1] as { partial?: Record<string, Uint8Array> };
			expect(opts.partial).toBeTruthy();
			const staged = new TextDecoder().decode(opts.partial!['m.txt']);
			// "b" removed (kept applied), "B" added, "d" left out.
			expect(staged).toBe('a\nB\nc\n');
		});

		it('commits with no partial payload when nothing was hand-edited', async () => {
			const commit = vi.fn().mockResolvedValue('deadbeef');
			const host = commitHost(commit);
			render(GitHistory, { props: { repoId: 'r', gitHost: host as never } });

			await fireEvent.input(await screen.findByTestId('git-commit-message'), { target: { value: 'msg' } });
			await fireEvent.input(screen.getByTestId('git-author-name'), { target: { value: 'T' } });
			await fireEvent.input(screen.getByTestId('git-author-email'), { target: { value: 't@t.test' } });
			await fireEvent.click(screen.getByTestId('git-commit-btn'));

			await vi.waitFor(() => expect(commit).toHaveBeenCalled());
			const opts = commit.mock.calls[0]![1] as { partial?: Record<string, Uint8Array> };
			expect(opts.partial).toBeUndefined();
		});
	});
});

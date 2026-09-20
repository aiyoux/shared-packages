import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/svelte';
import { __resetPersistKvForTests } from '@shared-packages/ui/persistKv';
import GitHistory from './GitHistory.svelte';

async function wipePersistKv(): Promise<void> {
	__resetPersistKvForTests();
	await new Promise<void>((resolve) => {
		const req = indexedDB.deleteDatabase('scratch-persist-kv');
		req.onsuccess = () => resolve();
		req.onerror = () => resolve();
		req.onblocked = () => resolve();
	});
}

describe('GitHistory', () => {
	beforeEach(async () => {
		await wipePersistKv();
	});

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

		function commitHost(opts: { commit?: ReturnType<typeof vi.fn> } = {}) {
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
				commit: opts.commit ?? vi.fn().mockResolvedValue('deadbeef'),
				discardFile: vi.fn().mockResolvedValue(undefined),
				discardAllFile: vi.fn().mockResolvedValue(undefined),
				discardRename: vi.fn().mockResolvedValue(undefined)
			};
		}

		/** A second changed file with two far-apart hunks, for bulk
		 *  select/deselect-all coverage (a single-hunk file's hunk checkbox
		 *  already covers that case, so it's excluded there). */
		function multiHunkHost() {
			const host = commitHost();
			host.diffFile = vi.fn().mockResolvedValue({
				oldText: 'l1\nl2\nl3\nl4\nl5\nl6\nl7\nl8\nl9\nl10\n',
				newText: 'l1\nL2\nl3\nl4\nl5\nl6\nl7\nL8\nl9\nl10\n',
				diff: {
					kind: 'text',
					hunks: [
						{
							oldStart: 1,
							oldLines: 3,
							newStart: 1,
							newLines: 3,
							lines: [
								{ kind: 'ctx', text: 'l1', oldNo: 1, newNo: 1, opIndex: 0 },
								{ kind: 'del', text: 'l2', oldNo: 2, newNo: null, opIndex: 1 },
								{ kind: 'add', text: 'L2', oldNo: null, newNo: 2, opIndex: 2 },
								{ kind: 'ctx', text: 'l3', oldNo: 3, newNo: 3, opIndex: 3 }
							]
						},
						{
							oldStart: 7,
							oldLines: 3,
							newStart: 7,
							newLines: 3,
							lines: [
								{ kind: 'ctx', text: 'l7', oldNo: 7, newNo: 7, opIndex: 4 },
								{ kind: 'del', text: 'l8', oldNo: 8, newNo: null, opIndex: 5 },
								{ kind: 'add', text: 'L8', oldNo: null, newNo: 8, opIndex: 6 },
								{ kind: 'ctx', text: 'l9', oldNo: 9, newNo: 9, opIndex: 7 }
							]
						}
					]
				}
			});
			return host;
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
			const host = commitHost({ commit });
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
			const host = commitHost({ commit });
			render(GitHistory, { props: { repoId: 'r', gitHost: host as never } });

			await fireEvent.input(await screen.findByTestId('git-commit-message'), { target: { value: 'msg' } });
			await fireEvent.input(screen.getByTestId('git-author-name'), { target: { value: 'T' } });
			await fireEvent.input(screen.getByTestId('git-author-email'), { target: { value: 't@t.test' } });
			await fireEvent.click(screen.getByTestId('git-commit-btn'));

			await vi.waitFor(() => expect(commit).toHaveBeenCalled());
			const opts = commit.mock.calls[0]![1] as { partial?: Record<string, Uint8Array> };
			expect(opts.partial).toBeUndefined();
		});

		it('discards a whole file after confirming, and does nothing when the user cancels', async () => {
			const host = commitHost();
			const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(false);
			render(GitHistory, { props: { repoId: 'r', gitHost: host as never } });
			await fireEvent.click(await screen.findByTestId('git-change-discard-m.txt'));
			expect(confirmSpy).toHaveBeenCalled();
			expect(host.discardAllFile).not.toHaveBeenCalled();

			confirmSpy.mockReturnValue(true);
			await fireEvent.click(screen.getByTestId('git-change-discard-m.txt'));
			await vi.waitFor(() => expect(host.discardAllFile).toHaveBeenCalledWith('r', 'm.txt'));
		});

		it('discards one hunk, staging the kept lines to disk', async () => {
			const host = commitHost();
			vi.spyOn(window, 'confirm').mockReturnValue(true);
			render(GitHistory, { props: { repoId: 'r', gitHost: host as never } });
			await fireEvent.click(await screen.findByTestId('git-change-expand-m.txt'));
			await fireEvent.click(await screen.findByTestId('git-diff-hunk-discard'));

			await vi.waitFor(() => expect(host.discardFile).toHaveBeenCalled());
			const [repoId, path, content] = host.discardFile.mock.calls[0]!;
			expect(repoId).toBe('r');
			expect(path).toBe('m.txt');
			// Discarding the whole (only) hunk reverts the file to oldText.
			expect(new TextDecoder().decode(content as Uint8Array)).toBe('a\nb\nc\n');
		});

		it('has no bulk select/deselect controls for a single-hunk file', async () => {
			const host = commitHost();
			render(GitHistory, { props: { repoId: 'r', gitHost: host as never } });
			await fireEvent.click(await screen.findByTestId('git-change-expand-m.txt'));
			await screen.findByTestId('git-diff-view');
			// The one hunk's own checkbox already is "select/deselect all" here.
			expect(screen.queryByTestId('git-change-select-all-m.txt')).toBeNull();
			expect(screen.queryByTestId('git-change-deselect-all-m.txt')).toBeNull();
		});

		it('deselect all / select all bulk-toggle every changed line in a multi-hunk file', async () => {
			const host = multiHunkHost();
			render(GitHistory, { props: { repoId: 'r', gitHost: host as never } });
			await fireEvent.click(await screen.findByTestId('git-change-expand-m.txt'));
			await screen.findByTestId('git-diff-view');

			await fireEvent.click(await screen.findByTestId('git-change-deselect-all-m.txt'));
			expect((await screen.findByTestId('git-change-partial-m.txt')).textContent).toContain('4');
			for (const check of screen.getAllByTestId('git-diff-line-check')) {
				expect((check as HTMLInputElement).checked).toBe(false);
			}

			await fireEvent.click(screen.getByTestId('git-change-select-all-m.txt'));
			expect(screen.queryByTestId('git-change-partial-m.txt')).toBeNull();
			for (const check of screen.getAllByTestId('git-diff-line-check')) {
				expect((check as HTMLInputElement).checked).toBe(true);
			}
		});
	});

	describe('renamed rows', () => {
		beforeEach(() => localStorage.clear());

		function renameHost(commit = vi.fn().mockResolvedValue('deadbeef')) {
			return {
				snapshot: () =>
					Promise.resolve({
						status: { branch: 'main', dirty: true },
						log: [],
						changes: [{ path: 'new.txt', status: 'renamed' as const, renamedFrom: 'old.txt' }]
					}),
				subscribe: () => () => {},
				diffFile: vi.fn(),
				discardFile: vi.fn(),
				discardAllFile: vi.fn(),
				discardRename: vi.fn().mockResolvedValue(undefined),
				commit
			};
		}

		it('shows old -> new with no expand affordance', async () => {
			render(GitHistory, { props: { repoId: 'r', gitHost: renameHost() as never } });
			const row = await screen.findByTestId('git-change-rename-new.txt');
			expect(row.textContent).toContain('old.txt');
			expect(row.textContent).toContain('new.txt');
			expect(screen.queryByTestId('git-change-expand-new.txt')).toBeNull();
		});

		it('discards (undoes) a rename after confirming', async () => {
			const host = renameHost();
			vi.spyOn(window, 'confirm').mockReturnValue(true);
			render(GitHistory, { props: { repoId: 'r', gitHost: host as never } });
			await fireEvent.click(await screen.findByTestId('git-change-discard-new.txt'));
			await vi.waitFor(() =>
				expect(host.discardRename).toHaveBeenCalledWith('r', 'new.txt', 'old.txt')
			);
		});

		it('stages both paths of a rename in one commit', async () => {
			const commit = vi.fn().mockResolvedValue('deadbeef');
			render(GitHistory, { props: { repoId: 'r', gitHost: renameHost(commit) as never } });
			await screen.findByTestId('git-change-rename-new.txt');

			await fireEvent.input(screen.getByTestId('git-commit-message'), { target: { value: 'rename' } });
			await fireEvent.input(screen.getByTestId('git-author-name'), { target: { value: 'T' } });
			await fireEvent.input(screen.getByTestId('git-author-email'), { target: { value: 't@t.test' } });
			// One row, but "Commit 1 file" — the label counts rows, not paths.
			expect(screen.getByTestId('git-commit-btn').textContent).toMatch(/Commit 1 file\b/);
			await fireEvent.click(screen.getByTestId('git-commit-btn'));

			await vi.waitFor(() => expect(commit).toHaveBeenCalled());
			const opts = commit.mock.calls[0]![1] as { paths: string[] };
			expect(opts.paths).toEqual(['old.txt', 'new.txt']);
		});
	});
});

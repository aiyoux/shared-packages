import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/svelte';
import GitHistory from './GitHistory.svelte';

describe('GitHistory', () => {
	it('renders empty state when no snapshot', () => {
		render(GitHistory, { props: { snapshot: null } });
		expect(screen.getByTestId('git-history')).toBeTruthy();
		expect(screen.getByTestId('git-history-empty').textContent).toMatch(/No repository selected/);
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
});

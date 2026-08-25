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
					log: [{ sha: 'abcdef123456', subject: 'hello' }]
				}
			}
		});
		expect(screen.getByTestId('git-history-branch').textContent).toMatch(/main/);
		expect(screen.getByTestId('git-history-dirty')).toBeTruthy();
		expect(screen.getByTestId('git-history-commit').textContent).toMatch(/abcdef1/);
		expect(screen.getByTestId('git-history-commit').textContent).toMatch(/hello/);
	});
});

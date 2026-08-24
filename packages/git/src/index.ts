export type {
	GitCommit,
	GitHost,
	GitRepoRef,
	GitSnapshot,
	GitStatus
} from './types.js';
export { createGitHost, type CreateGitHostOptions } from './host.js';
export { localReadBlobAt, localSnapshot, type GitFs } from './local.js';
export { createVfsGitFs, type CreateVfsGitFsOptions } from './vfsGitFs.js';
export { ensureBuffer } from './ensureBuffer.js';
export {
	mapMonitorGitSnapshot,
	monitorSnapshot,
	monitorSubscribe,
	profileFromRepo
} from './monitor.js';
export {
	closeGitReposDbForTests,
	deleteRepo,
	getRepo,
	GIT_REPOS_DB_NAME,
	GIT_REPOS_STORE,
	listRepos,
	putRepo
} from './repos.js';
export {
	consumeOpenProject,
	OPEN_PROJECT_KEY,
	OPEN_PROJECT_TTL_MS,
	type OpenProjectPayload
} from './openProject.js';

export { default as GitHistory } from './GitHistory.svelte';
export { default as GitApp } from './GitApp.svelte';
export { default as ProjectApp } from './ProjectApp.svelte';

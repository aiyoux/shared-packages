export type {
	CommitInput,
	GitAuthor,
	GitChange,
	GitCommit,
	GitFileDiff,
	GitHost,
	GitRepoRef,
	GitSnapshot,
	GitStatus
} from './types.js';
export {
	applySelection,
	diffLines,
	type DiffHunk,
	type DiffLine,
	type DiffLineKind,
	type FileDiff
} from './diffLines.js';
export { createGitHost, type CreateGitHostOptions } from './host.js';
export {
	ROOM_BRANCH_PREFIX,
	localBranch,
	localCommit,
	localDeleteBranch,
	localDeleteWorkingFile,
	localDiffFile,
	localDiscardAllFile,
	localDiscardRename,
	localFetch,
	localFindMergeBase,
	localIndexPack,
	localListBranches,
	localMerge,
	localPackObjects,
	localReadBlobAt,
	localReadWorkingFile,
	localSnapshot,
	localWriteWorkingFile,
	roomBranchName,
	type FetchResult,
	type GitFs,
	type HttpClient,
	type LocalBranchOpts,
	type LocalFetchOpts,
	type LocalMergeOpts,
	type MergeDriverCallback,
	type MergeResult,
	type PackObjectsResult
} from './local.js';
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
	forgetProject,
	LAST_PROJECT_KEY,
	OPEN_PROJECT_KEY,
	OPEN_PROJECT_TTL_MS,
	recallProject,
	rememberProject,
	type OpenProjectPayload
} from './openProject.js';

export { default as GitHistory } from './GitHistory.svelte';
export { default as GitApp } from './GitApp.svelte';
export { default as ProjectApp } from './ProjectApp.svelte';
export {
	bindProjectRepo,
	bindRepoIfProject,
	repoInputFromFolder,
	resolveProjectRoot,
	sameProjectRepo,
	type ProjectBackendHint,
	type ProjectRootResolution
} from './projectRepo.js';

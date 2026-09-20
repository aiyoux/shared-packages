/** Same vocabulary as animation clips: clone / live / snapshot / git-pin. */
export type VfsBindMode = 'clone' | 'live' | 'snapshot' | 'gitPin';

export type BindPromptIds = {
	prompt: string;
	bindClone: string;
	bindLive: string;
	bindSnapshot: string;
	bindGitpin?: string;
	gitSnapshot?: string;
};

export type BindPromptPending = {
	label: string;
	git?: boolean;
	cloneOnly?: boolean;
	liveDisabled?: boolean;
	liveTitle?: string;
};

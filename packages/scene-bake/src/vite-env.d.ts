interface ImportMetaEnv {
	DEV?: boolean;
	BASE_URL?: string;
}

interface ImportMeta {
	readonly env: ImportMetaEnv;
	readonly url: string;
}

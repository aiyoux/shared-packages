/** An expected domain rejection is an ordered no-op, not a transport repair. */
export class DocOpRejected extends Error {
	constructor(message: string) { super(message); this.name = 'DocOpRejected'; }
}
export type DocCommitResult = { accepted: true; changed: boolean } | { accepted: false; message: string };
export type DocCommitOptions = { signal?: AbortSignal; requestId?: string };

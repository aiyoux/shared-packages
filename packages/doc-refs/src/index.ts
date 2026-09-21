/**
 * The vocabulary a document uses to point at another document.
 *
 * Lives in its own package because it belongs to no product. It was declared
 * in the animation package, which made every consumer of one type — a
 * composition of audio recordings, the hub's reference pipeline, a drawing
 * tool — depend on animation to say "this points at a VFS node". The voice-rec
 * app declined that dependency and re-declared the shape structurally instead,
 * which is the drift the single-declaration rule exists to prevent: two
 * spellings of one contract, kept in step by nothing but attention.
 *
 * Zero dependencies, and it must stay that way. Anything that needs to *read*
 * a reference — resolve it, rewrite it, walk it for cycles — belongs to the
 * subsystem doing the reading, not here. This package says only what a
 * reference is.
 */
export {
	BIND_MODES,
	type BindMode,
	type DocSource,
	type FsBackend,
	type MonitorDocSource,
	type VfsDocSource
} from './docSource.js';

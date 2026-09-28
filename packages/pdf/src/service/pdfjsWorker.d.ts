// pdfjs-dist ships no types for its worker entry; only the handler is read.
// Referenced from engines.ts so every program that compiles it sees this, not
// only this package's own.
declare module 'pdfjs-dist/legacy/build/pdf.worker.mjs' {
	export const WorkerMessageHandler: unknown;
}

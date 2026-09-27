// Vite resolves these in the consuming app's build; tsc only needs shapes.
declare module '*?worker' {
	const WorkerFactory: new (options?: { name?: string }) => Worker;
	export default WorkerFactory;
}
declare module '*?url' {
	const url: string;
	export default url;
}
// pdfjs-dist ships no types for its worker entry; only the handler is read.
declare module 'pdfjs-dist/legacy/build/pdf.worker.mjs' {
	export const WorkerMessageHandler: unknown;
}

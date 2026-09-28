// Vite resolves these in the consuming app's build; tsc only needs shapes.
declare module '*?worker' {
	const WorkerFactory: new (options?: { name?: string }) => Worker;
	export default WorkerFactory;
}
declare module '*?url' {
	const url: string;
	export default url;
}

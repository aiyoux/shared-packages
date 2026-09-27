/**
 * Ambient declaration so typechecking sources imported from
 * `@shared-packages/file-system` (whose catalog uses Vite `?worker`
 * imports) resolves without Vite's client types.
 */
declare module '*?worker' {
	const workerConstructor: new (options?: { name?: string; type?: WorkerType }) => Worker;
	export default workerConstructor;
}
declare module '*?worker&inline' {
	const workerConstructor: new (options?: { name?: string; type?: WorkerType }) => Worker;
	export default workerConstructor;
}
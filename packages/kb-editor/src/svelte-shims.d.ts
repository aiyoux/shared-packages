declare module '*.svelte' {
	import type { Component } from 'svelte';
	const comp: Component;
	export default comp;
}

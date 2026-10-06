// jsdom has no visual frame loop and no ResizeObserver. The trim timeline
// only needs "next frame" and "remeasure on observe" semantics.
globalThis.requestAnimationFrame = (cb) => setTimeout(() => cb(Date.now()), 16);
globalThis.cancelAnimationFrame = (id) => clearTimeout(id);

globalThis.ResizeObserver = class {
	constructor(cb) {
		this.cb = cb;
	}
	observe() {
		queueMicrotask(() => this.cb());
	}
	unobserve() {}
	disconnect() {}
};

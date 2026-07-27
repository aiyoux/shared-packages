// @shared-packages/drawing-tools — headless 2D drawing primitives shared by
// svg-sketcher and web_social_games. Pure logic + types; no Svelte, no DOM
// (the worker is a separate entry — see package.json `exports["./worker"]`).

export * from './types.ts';
export * from './id.ts';
export * from './path.ts';
export * from './brush.ts';
export * from './raster.ts';
export * from './clipping.ts';
export * from './eraseDelta.ts';
export * from './eraser.ts';
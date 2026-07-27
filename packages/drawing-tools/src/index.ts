// @shared-packages/drawing-tools — headless 2D drawing primitives shared by
// svg-sketcher and web_social_games. Pure logic + types; no Svelte, no DOM
// (the worker is a separate entry — see package.json `exports["./worker"]`).

export * from './types';
export * from './id';
export * from './path';
export * from './brush';
export * from './raster';
export * from './clipping';
export * from './eraseDelta';
export * from './eraser';
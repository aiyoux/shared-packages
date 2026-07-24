// Date-model barrel — the reusable, dependency-free date/time vocabulary.
// Re-exported by `@modular@shared-packages/ui` (root) and by `@modular@shared-packages/ui/date`
// (subpath, used by @modular-app/module-sdk so it can re-export the date model
// without pulling in the Svelte components).
export * from './types.ts';
export * from './vague-time.ts';
export * from './time.ts';
export * from './time-week.ts';
export * from './time-reference.ts';
export * from './time-reference-normalize.ts';
export * from './relevance.ts';
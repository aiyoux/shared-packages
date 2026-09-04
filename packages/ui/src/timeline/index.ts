/**
 * Shared timeline chrome — zoom controls, an overview minimap, and the pan /
 * zoom gesture glue. The viewport maths live in `@shared-packages/composition`
 * (`createTimelineViewport`, `zoomAtAnchor`, `rulerTicks`, …); these are the
 * reusable DOM pieces on top of it.
 */
export { default as TimelineZoomControls } from './TimelineZoomControls.svelte';
export { default as TimelineMinimap } from './TimelineMinimap.svelte';
export { createTimelinePan } from './pan.ts';
export type { TimelinePanContext, TimelinePanHandlers } from './pan.ts';

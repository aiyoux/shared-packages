/**
 * @shared-packages/design-system
 *
 * Design tokens, reset, themes, and Svelte primitives.
 *
 * CSS is consumed via the exported subpaths:
 *   import '@shared-packages/design-system/tokens.css';
 *   import '@shared-packages/design-system/reset.css';
 *   import '@shared-packages/design-system/themes.css';
 *
 * Primitives are token-driven, plain-scoped-CSS components (no Tailwind
 * dependency) so they work in every consumer. See scratch-pad
 * docs/design/design-system.md for the architecture.
 */
export { default as Button } from './components/Button.svelte';
export { default as Card } from './components/Card.svelte';
export { default as Input } from './components/Input.svelte';
export { default as FormGroup } from './components/FormGroup.svelte';
export { default as Tooltip } from './components/Tooltip.svelte';
export { default as LevelMeter } from './components/LevelMeter.svelte';
export { default as Sidebar, type SidebarNavItem } from './components/Sidebar.svelte';

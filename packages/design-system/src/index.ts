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
 *
 * Theme contract: studio is the un-themed default (`tokens.css` `:root`).
 * Set `data-theme` to a `NamedTheme` to apply a first-class overlay from
 * `themes.css`. Product value `terminal` remains as a small surface override;
 * `voice` / `prompter` / `dictionary` / `sketcher` inherit studio.
 */
export const NAMED_THEMES = ['paper', 'dark', 'midnight', 'forest', 'neon'] as const;
export type NamedTheme = (typeof NAMED_THEMES)[number];

export { default as Button } from './components/Button.svelte';
export { default as Card } from './components/Card.svelte';
export { default as Input } from './components/Input.svelte';
export { default as Label } from './components/Label.svelte';
export { default as Badge } from './components/Badge.svelte';
export { default as Select } from './components/Select.svelte';
export type { SelectOption } from './components/select.ts';
export { default as FormGroup } from './components/FormGroup.svelte';
export { default as Tooltip } from './components/Tooltip.svelte';
export { default as LevelMeter } from './components/LevelMeter.svelte';
export { default as Sidebar, type SidebarNavItem } from './components/Sidebar.svelte';

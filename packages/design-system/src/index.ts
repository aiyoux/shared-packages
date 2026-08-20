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
 * Theme contract: studio dark (cyber wireframe) is the un-themed default
 * (`tokens.css` `:root`). Hosts set `data-color-scheme` to `dark` | `light`
 * (default `dark`). Set `data-theme` to a `NamedTheme` for a named overlay
 * from `themes.css`. Mounted products inherit studio; they do not ship a
 * second identity overlay. Tailwind apps import `./tailwind-theme.css` so
 * utility colors follow the same tokens.
 */
export const NAMED_THEMES = ['light', 'paper', 'dark', 'midnight', 'forest', 'neon'] as const;
export type NamedTheme = (typeof NAMED_THEMES)[number];

export {
	COLOR_SCHEMES,
	COLOR_SCHEME_STORAGE_KEY,
	DEFAULT_COLOR_SCHEME,
	THEME_COLOR,
	applyColorScheme,
	isColorScheme,
	persistColorScheme,
	readStoredColorScheme,
	type ColorScheme
} from './color-scheme.ts';

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

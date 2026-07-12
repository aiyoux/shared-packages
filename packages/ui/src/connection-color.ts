// Per-connection accent color.
//
// Each connection gets a stable, deterministic accent color derived from its
// immutable `connectionKey` (DbProfile.key) via an FNV-1a hash mapped onto a
// 12-slot OKLCH hue palette. `DbProfile.color` overrides the derived color as a
// raw CSS color passthrough (any valid CSS color string). Used by the host's
// provenance surfaces (notice chips, activity-feed group headers, sidebar) —
// keyed off the connection key so the same connection always renders the same
// accent across reloads and tabs.

const PALETTE_LIGHTNESS = 0.62;
const PALETTE_CHROMA = 0.15;
const PALETTE_SLOTS = 12;
const HUE_STEP = 360 / PALETTE_SLOTS;

// FNV-1a 32-bit + a murmur3-style finalizer (avalanche) — stable,
// dependency-free, and distributes well even on structured/sequential inputs
// (real connection keys are UUIDs, but robustness is cheap).
function hashKey(key: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < key.length; i++) {
    h ^= key.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  return h >>> 0;
}

/**
 * Returns the accent color for a connection. When `override` is a non-empty
 * string it is returned verbatim (a raw CSS color from `DbProfile.color`);
 * otherwise a deterministic OKLCH color is derived from `key`.
 */
export function getConnectionColor(key: string, override?: string | null): string {
  if (override && override.trim()) return override;
  const hue = (hashKey(key) % PALETTE_SLOTS) * HUE_STEP;
  return `oklch(${PALETTE_LIGHTNESS} ${PALETTE_CHROMA} ${hue}deg)`;
}
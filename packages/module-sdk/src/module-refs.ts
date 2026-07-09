/**
 * Reserved `refs: {}` convention for record references inside module_settings.
 *
 * module_settings is a module-PRIVATE blob the platform never inspects — with
 * one exception: any object literally keyed `refs` (at any depth) is a flat
 * `Record<string, string | string[]>` of record ids that the sync engine
 * blindly remaps during temp→real id resolution (see RefScope in
 * sync/engine.ts). Modules MUST route every record reference through a refs
 * object; a reference stored as a plain top-level key is invisible to the
 * remapper and its temp id dangles forever after the referenced record is
 * created.
 *
 * These accessors operate on one module namespace object (e.g. the value of
 * `module_settings.money_module.financial_transaction`) and return NEW
 * objects so Svelte reactivity and the op pipeline see the change.
 */

type RefValue = string | string[];

function refsOf(ns: Record<string, unknown> | null | undefined): Record<string, unknown> {
  const raw = ns?.refs;
  return raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
}

/** Read a single record ref off a namespace's refs object. */
export function readRef(ns: Record<string, unknown> | null | undefined, key: string): string | null {
  const value = refsOf(ns)[key];
  return typeof value === 'string' && value !== '' ? value : null;
}

/** Read a record-ref list off a namespace's refs object. */
export function readRefList(ns: Record<string, unknown> | null | undefined, key: string): string[] {
  const value = refsOf(ns)[key];
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string') : [];
}

/**
 * Return a new namespace object with `refs[key]` set (or removed when value
 * is null/undefined/empty). Creates the refs object on demand; drops it when
 * it empties out.
 */
export function setRef(
  ns: Record<string, unknown> | null | undefined,
  key: string,
  value: RefValue | null | undefined
): Record<string, unknown> {
  const base = { ...(ns ?? {}) };
  const refs = { ...refsOf(ns) };
  const empty = value == null || value === '' || (Array.isArray(value) && value.length === 0);
  if (empty) {
    delete refs[key];
  } else {
    refs[key] = value;
  }
  if (Object.keys(refs).length === 0) {
    delete base.refs;
  } else {
    base.refs = refs;
  }
  return base;
}

/** Convenience: setRef(ns, key, null). */
export function deleteRef(ns: Record<string, unknown> | null | undefined, key: string): Record<string, unknown> {
  return setRef(ns, key, null);
}

/** Build a namespace fragment carrying only refs (for object literals). */
export function refsObject(entries: Record<string, RefValue | null | undefined>): { refs: Record<string, RefValue> } | Record<string, never> {
  const refs: Record<string, RefValue> = {};
  for (const [key, value] of Object.entries(entries)) {
    if (value == null || value === '' || (Array.isArray(value) && value.length === 0)) continue;
    refs[key] = value;
  }
  return Object.keys(refs).length > 0 ? { refs } : {};
}

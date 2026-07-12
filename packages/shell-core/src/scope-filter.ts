// Global ScopeFilter — composable tree-descendant filter that pages can opt into.
// Mirrors the role of wisewords' `scp` URL param, generalised so multiple
// scopes can be combined with AND / OR and negation.

export type RecordIdLike = string;

export type ScopeStrategy = 'auto' | 'top-down' | 'bottom-up';

export type ScopeNode =
  | { kind: 'in'; ids: RecordIdLike[] }
  | { kind: 'not_in'; ids: RecordIdLike[] }
  | { kind: 'all'; nodes: ScopeNode[] }
  | { kind: 'any'; nodes: ScopeNode[] };

export interface ScopeFilter {
  root: ScopeNode | null;
  strategy: ScopeStrategy;
}

export const EMPTY_SCOPE_FILTER: ScopeFilter = { root: null, strategy: 'auto' };

// --- normalisation -----------------------------------------------------------

function normaliseId(id: RecordIdLike): string {
  return id.startsWith('records:') ? id.slice('records:'.length) : id;
}

function normaliseIds(ids: RecordIdLike[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of ids) {
    const id = normaliseId(raw);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out;
}

export function normaliseNode(node: ScopeNode | null): ScopeNode | null {
  if (!node) return null;
  switch (node.kind) {
    case 'in':
    case 'not_in': {
      const ids = normaliseIds(node.ids);
      if (ids.length === 0) return null;
      return { kind: node.kind, ids };
    }
    case 'all':
    case 'any': {
      const nodes = node.nodes
        .map(normaliseNode)
        .filter((n): n is ScopeNode => n !== null);
      if (nodes.length === 0) return null;
      if (nodes.length === 1) return nodes[0];
      return { kind: node.kind, nodes };
    }
  }
}

export function normaliseFilter(filter: ScopeFilter): ScopeFilter {
  return {
    root: normaliseNode(filter.root),
    strategy: filter.strategy ?? 'auto'
  };
}

export function isFilterActive(filter: ScopeFilter | null | undefined): boolean {
  return Boolean(filter && filter.root && normaliseNode(filter.root));
}

// --- URL encoding ------------------------------------------------------------
//
// Compact form for short filters: `in:a,b;not_in:c`.
// Anything composite (nested all/any) falls through to base64-json.
// Both forms are accepted on decode; encode prefers compact when possible.

function tryCompactEncode(node: ScopeNode): string | null {
  if (node.kind === 'in' || node.kind === 'not_in') {
    return `${node.kind}:${node.ids.join(',')}`;
  }
  if (node.kind === 'all') {
    const parts: string[] = [];
    for (const child of node.nodes) {
      if (child.kind !== 'in' && child.kind !== 'not_in') return null;
      const part = tryCompactEncode(child);
      if (part === null) return null;
      parts.push(part);
    }
    return parts.join(';');
  }
  return null;
}

function compactDecode(input: string): ScopeNode | null {
  const segments = input.split(';').filter(Boolean);
  const nodes: ScopeNode[] = [];
  for (const seg of segments) {
    const idx = seg.indexOf(':');
    if (idx < 0) return null;
    const kind = seg.slice(0, idx);
    const ids = seg.slice(idx + 1).split(',').map(s => s.trim()).filter(Boolean);
    if (kind !== 'in' && kind !== 'not_in') return null;
    nodes.push({ kind, ids });
  }
  if (nodes.length === 0) return null;
  if (nodes.length === 1) return nodes[0];
  return { kind: 'all', nodes };
}

function base64UrlEncode(s: string): string {
  if (typeof btoa === 'function') {
    return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }
  return Buffer.from(s, 'utf8').toString('base64')
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function base64UrlDecode(s: string): string {
  const pad = s.length % 4 === 0 ? '' : '='.repeat(4 - (s.length % 4));
  const fixed = s.replace(/-/g, '+').replace(/_/g, '/') + pad;
  if (typeof atob === 'function') return atob(fixed);
  return Buffer.from(fixed, 'base64').toString('utf8');
}

export function encodeScopeFilter(filter: ScopeFilter): string | null {
  const norm = normaliseFilter(filter);
  if (!norm.root) return null;
  const strategyPrefix = norm.strategy && norm.strategy !== 'auto' ? `s=${norm.strategy};` : '';
  const compact = tryCompactEncode(norm.root);
  if (compact !== null) return strategyPrefix + compact;
  const json = JSON.stringify(norm.root);
  return strategyPrefix + 'b64=' + base64UrlEncode(json);
}

export function decodeScopeFilter(input: string | null | undefined): ScopeFilter {
  if (!input) return EMPTY_SCOPE_FILTER;
  let body = input;
  let strategy: ScopeStrategy = 'auto';
  const sMatch = body.match(/^s=(auto|top-down|bottom-up);/);
  if (sMatch) {
    strategy = sMatch[1] as ScopeStrategy;
    body = body.slice(sMatch[0].length);
  }
  let root: ScopeNode | null = null;
  if (body.startsWith('b64=')) {
    try {
      const json = base64UrlDecode(body.slice(4));
      root = JSON.parse(json) as ScopeNode;
    } catch {
      root = null;
    }
  } else {
    root = compactDecode(body);
  }
  return normaliseFilter({ root, strategy });
}

// --- multi-connection envelope -----------------------------------------------
//
// v2 URL envelope: `scp=v2.<base64url(JSON { [connKey]: encodeScopeFilter(filter) })>`.
// Each segment is keyed by connectionKey so a filter applies only to its own
// connection (no cross-connection poisoning on switch). Segments for connections
// the caller doesn't know are DROPPED on decode (the leak/stray-state fix).
// Non-`v2.` input decodes empty — old single-filter links are dead by design.

export interface MultiScopeParam {
  byConnection: Record<string, ScopeFilter>;
}

// Returns null when no connection has an active filter (so the `scp` param is
// deleted rather than carried empty).
export function encodeMultiScopeParam(p: MultiScopeParam): string | null {
  const out: Record<string, string> = {};
  for (const [key, filter] of Object.entries(p.byConnection)) {
    const enc = encodeScopeFilter(filter); // null for inactive/empty filters
    if (enc !== null) out[key] = enc;
  }
  if (Object.keys(out).length === 0) return null;
  return 'v2.' + base64UrlEncode(JSON.stringify(out));
}

// Unknown keys (not in `knownConnectionKeys`) are dropped. Malformed input
// (non-v2, bad base64, non-object JSON) → empty `byConnection`.
export function decodeMultiScopeParam(
  input: string | null | undefined,
  knownConnectionKeys: string[]
): MultiScopeParam {
  if (!input || !input.startsWith('v2.')) return { byConnection: {} };
  const known = new Set(knownConnectionKeys);
  try {
    const obj = JSON.parse(base64UrlDecode(input.slice(3)));
    if (!obj || typeof obj !== 'object' || Array.isArray(obj)) {
      return { byConnection: {} };
    }
    const byConnection: Record<string, ScopeFilter> = {};
    for (const [key, val] of Object.entries(obj)) {
      if (!known.has(key)) continue; // drop unknown connection
      if (typeof val !== 'string') continue;
      byConnection[key] = decodeScopeFilter(val);
    }
    return { byConnection };
  } catch {
    return { byConnection: {} };
  }
}

// --- client-side evaluation --------------------------------------------------
//
// Used to filter cached items in-memory (e.g. recent items list) without a
// round-trip. Requires a function that resolves an id to its ancestor chain.

export interface ScopeAncestry {
  // Returns ancestor record ids (parents, grandparents, ...) for an item.
  ancestors(id: RecordIdLike): RecordIdLike[];
}

function isUnderAny(id: RecordIdLike, scopeIds: string[], anc: ScopeAncestry): boolean {
  const target = normaliseId(id);
  if (scopeIds.includes(target)) return true;
  for (const a of anc.ancestors(target)) {
    if (scopeIds.includes(normaliseId(a))) return true;
  }
  return false;
}

export function evaluateScopeNode(
  node: ScopeNode,
  id: RecordIdLike,
  anc: ScopeAncestry
): boolean {
  switch (node.kind) {
    case 'in': return isUnderAny(id, node.ids, anc);
    case 'not_in': return !isUnderAny(id, node.ids, anc);
    case 'all': return node.nodes.every(n => evaluateScopeNode(n, id, anc));
    case 'any': return node.nodes.some(n => evaluateScopeNode(n, id, anc));
  }
}

export function evaluateFilter(
  filter: ScopeFilter,
  id: RecordIdLike,
  anc: ScopeAncestry
): boolean {
  if (!filter.root) return true;
  return evaluateScopeNode(filter.root, id, anc);
}

// --- collect referenced ids --------------------------------------------------

export function collectReferencedIds(node: ScopeNode | null): string[] {
  if (!node) return [];
  const out = new Set<string>();
  const walk = (n: ScopeNode) => {
    if (n.kind === 'in' || n.kind === 'not_in') {
      for (const id of n.ids) out.add(normaliseId(id));
    } else {
      for (const c of n.nodes) walk(c);
    }
  };
  walk(node);
  return [...out];
}

// --- SurQL fragment builder --------------------------------------------------
//
// Builds a SurQL boolean fragment that evaluates to true iff the row at
// `idExpr` (a SurQL expression of type `record`, e.g. `$this.id`) satisfies
// the filter. Bound parameters are returned alongside.
//
// Strategy selects between two equivalent shapes:
//   - top-down: precompute descendants once and use `id INSIDE $set_X`.
//   - bottom-up: per-row `fn::is_under_scope(id, [..roots..])`.
//
// The 'auto' strategy uses a deterministic structural heuristic. Simple
// positive scope filters use top-down; filters that are composite, OR-heavy,
// exclusion-heavy, or reference many roots use bottom-up to avoid building many
// recursive descendant sets before the main query can apply its own filters.

export interface ScopeSurqlFragment {
  // SurQL `LET $name = ...;` statements that must be emitted before the WHERE.
  preamble: string[];
  // SurQL boolean expression to AND into the WHERE clause. Empty string if no-op.
  whereExpr: string;
  // Variables to bind alongside the query.
  vars: Record<string, unknown>;
  // The concrete query shape selected after resolving `auto`.
  selectedStrategy: Exclude<ScopeStrategy, 'auto'> | null;
}

interface BuildCtx {
  idExpr: string;
  strategy: Exclude<ScopeStrategy, 'auto'>;
  letCounter: { n: number };
  varCounter: { n: number };
  preamble: string[];
  vars: Record<string, unknown>;
}

interface ScopeShapeStats {
  inLeaves: number;
  notInLeaves: number;
  groupNodes: number;
  anyGroups: number;
  maxDepth: number;
  referencedIds: number;
}

function scopeShapeStats(node: ScopeNode, depth = 0): ScopeShapeStats {
  if (node.kind === 'in' || node.kind === 'not_in') {
    return {
      inLeaves: node.kind === 'in' ? 1 : 0,
      notInLeaves: node.kind === 'not_in' ? 1 : 0,
      groupNodes: 0,
      anyGroups: 0,
      maxDepth: depth,
      referencedIds: node.ids.length
    };
  }

  const out: ScopeShapeStats = {
    inLeaves: 0,
    notInLeaves: 0,
    groupNodes: 1,
    anyGroups: node.kind === 'any' ? 1 : 0,
    maxDepth: depth,
    referencedIds: 0
  };

  for (const child of node.nodes) {
    const childStats = scopeShapeStats(child, depth + 1);
    out.inLeaves += childStats.inLeaves;
    out.notInLeaves += childStats.notInLeaves;
    out.groupNodes += childStats.groupNodes;
    out.anyGroups += childStats.anyGroups;
    out.maxDepth = Math.max(out.maxDepth, childStats.maxDepth);
    out.referencedIds += childStats.referencedIds;
  }

  return out;
}

export function chooseScopeStrategy(filter: ScopeFilter): Exclude<ScopeStrategy, 'auto'> {
  const norm = normaliseFilter(filter);
  if (norm.strategy === 'top-down' || norm.strategy === 'bottom-up') {
    return norm.strategy;
  }
  if (!norm.root) {
    return 'top-down';
  }

  const stats = scopeShapeStats(norm.root);
  const leafCount = stats.inLeaves + stats.notInLeaves;
  const isSinglePositiveLeaf =
    norm.root.kind === 'in' ||
    (norm.root.kind === 'all' && stats.inLeaves === leafCount && leafCount <= 2 && stats.maxDepth <= 1);

  if (isSinglePositiveLeaf && stats.referencedIds <= 8) {
    return 'top-down';
  }
  if (stats.notInLeaves > stats.inLeaves) {
    return 'bottom-up';
  }
  if (stats.anyGroups > 0 || stats.maxDepth > 1 || leafCount > 2 || stats.referencedIds > 8) {
    return 'bottom-up';
  }
  return 'top-down';
}

function bindRecordIds(ids: string[], ctx: BuildCtx): string {
  const idx = ctx.varCounter.n++;
  const varName = `scope_ids_${idx}`;
  ctx.vars[varName] = ids.map((id) => `records:${id}`);
  return `<array<record>>$${varName}`;
}

function buildNodeExpr(node: ScopeNode, ctx: BuildCtx): string {
  switch (node.kind) {
    case 'in':
    case 'not_in': {
      const negate = node.kind === 'not_in';
      const arr = bindRecordIds(node.ids, ctx);
      if (ctx.strategy === 'bottom-up') {
        const expr = `fn::is_under_scope(${ctx.idExpr}, ${arr})`;
        return negate ? `!(${expr})` : expr;
      }
      // top-down (default for 'auto' too): precompute set, INSIDE check
      const idx = ctx.letCounter.n++;
      const setName = `$scope_set_${idx}`;
      ctx.preamble.push(
        `LET ${setName} = fn::find_all_child_records_any_type(${arr}, [], {}, [], NONE, NONE);`
      );
      const expr = `(${ctx.idExpr} INSIDE ${setName} OR ${ctx.idExpr} INSIDE ${arr})`;
      return negate ? `!${expr}` : expr;
    }
    case 'all':
      return '(' + node.nodes.map(n => buildNodeExpr(n, ctx)).join(' AND ') + ')';
    case 'any':
      return '(' + node.nodes.map(n => buildNodeExpr(n, ctx)).join(' OR ') + ')';
  }
}

export function buildScopeSurql(
  filter: ScopeFilter,
  idExpr: string = '$this.id'
): ScopeSurqlFragment {
  const norm = normaliseFilter(filter);
  if (!norm.root) {
    return { preamble: [], whereExpr: '', vars: {}, selectedStrategy: null };
  }
  const selectedStrategy = chooseScopeStrategy(norm);
  const ctx: BuildCtx = {
    idExpr,
    strategy: selectedStrategy,
    letCounter: { n: 0 },
    varCounter: { n: 0 },
    preamble: [],
    vars: {}
  };
  const whereExpr = buildNodeExpr(norm.root, ctx);
  return { preamble: ctx.preamble, whereExpr, vars: ctx.vars, selectedStrategy };
}

/**
 * Shared template-clone date resolution.
 *
 * SINGLE canonical implementation used by every clone surface (calendar &
 * exec apply-template, the /records manual clone). Previously calendar and
 * exec each carried an identical private copy of this logic + resolve
 * context — divergence between clone surfaces is exactly the class of bug
 * the clone-parity / preview-parity suites guard against, so there must be
 * only one implementation. Do NOT reintroduce per-surface copies.
 *
 * `resolveTemplateAdditionals` materialises a template node's relative date
 * references against `anchor` (and its parent's resolved start, for
 * parent-relative offsets). When a surface clones "as-is" it simply does
 * not call this — verbatim copy is the absence of resolution, not a second
 * code path.
 */
import type { Item } from './types.ts';
import type { TimeReference, StartOrEnd, ResolveContext } from '@modular-app/ui/date';
import type { CloneSetting } from './cache/types.ts';
import { resolveStart, materializeTimeReference } from '@modular-app/ui/date';
import { isDateAdditional, getDateAdditionalData, patchDateAdditional } from './date-additional.ts';

export function templateResolveContext(anchor: Date, parentResolved: Date | null): ResolveContext {
  return {
    userProvided: anchor,
    parentResolved: parentResolved ?? anchor
  };
}

export function resolveTemplateAdditionals(
  additionals: Item['additionals'],
  anchor: Date,
  parentResolved: Date | null,
  inheritedParentMinutes: StartOrEnd<any, number> | undefined,
  idFactory: () => string
): { additionals: NonNullable<Item['additionals']>; primaryStart: Date | null; primaryValue: TimeReference | null } {
  const resolvedAdditionals = (additionals ?? []).map((additional) => {
    if (!isDateAdditional(additional)) {
      return { ...structuredClone(additional), id: idFactory() };
    }
    const rawData = getDateAdditionalData(additional);
    if (!rawData?.date_info?.value) {
      return { ...structuredClone(additional), id: idFactory() };
    }
    const data = structuredClone(rawData);
    const ctx = templateResolveContext(anchor, parentResolved);
    data.date_info = {
      ...data.date_info,
      source_additional_id: additional.id,
      value: materializeTimeReference(data.date_info.value as TimeReference, anchor, ctx, {
        inheritedParentMinuteRange: inheritedParentMinutes as any
      })
    };
    const patched = patchDateAdditional(additional, data);
    return { ...patched, id: idFactory() };
  });

  const resolvedPrimary = resolvedAdditionals.find(isDateAdditional);
  const resolvedValue = resolvedPrimary ? getDateAdditionalData(resolvedPrimary)?.date_info?.value : undefined;
  const primaryStart = resolvedValue
    ? resolveStart(resolvedValue as TimeReference, anchor, templateResolveContext(anchor, parentResolved))
    : null;

  return {
    additionals: resolvedAdditionals,
    primaryStart,
    primaryValue: (resolvedValue as TimeReference | undefined) ?? null
  };
}

// ---------------------------------------------------------------------------
// Shared clone-region traversal — the SINGLE source of structural truth.
//
// Every client clone surface (exec & calendar apply-template, the /records
// manual clone) needs the same thing: walk a source subtree and capture, per
// internal edge, its `order`, `key_parent` and `clone_setting`, plus the
// `link_to_original` relationships. That derivation was previously hand-rolled
// in each surface and drifted — order/key_parent/clone_setting got hardcoded
// differently, causing flat-tree / lost-sibling-order bugs fixed three times
// (commits 75432c8, ac450e4, 2a7a9a5). It now lives ONLY here. Each surface
// still owns its (genuinely different, not bug-prone) record-content,
// root-attachment and groups policy — but never re-derives edge structure.
//
// Mirrors the server `fn::collect_clone_region` / `fn::group_for_clone`
// (in surql tree_ops.surql): clone the reachable node region, recreate every
// internal graph_child_of edge with its source attributes, and treat
// `link_to_original` edges as "don't clone the child; link the original".
// ---------------------------------------------------------------------------

/** Minimal cache surface the traversal needs (AppRuntime.cache satisfies it). */
export interface CloneRegionCache {
  getItem(id: string): Item | undefined;
  get_children_for_parent(parentId: string): Array<{
    child_id: string;
    order?: number;
    is_key_parent?: boolean;
    clone_setting?: CloneSetting | null;
    module_data?: Record<string, unknown>;
    edge_id?: string;
  }>;
}

export interface CloneRegionNode {
  sourceId: string;
  /** Source id of the parent this node was FIRST reached from (null for a
   *  seed). Used only to thread parent-relative date resolution — NOT for
   *  edge creation (use `internalEdges`). */
  parentSourceId: string | null;
}

export interface CloneRegionEdge {
  parentSourceId: string;
  childSourceId: string;
  /** Source edge `order` (0 when absent). */
  order: number;
  /** Source edge `key_parent` — absent/undefined means key (true). */
  keyParent: boolean;
  /** Source edge `clone_setting` (null when absent → default). */
  cloneSetting: CloneSetting | null;
  /** Source edge module data. */
  moduleData?: Record<string, unknown>;
}

export interface CloneRegionLinkOriginal {
  /** The ORIGINAL child record id (not cloned; linked under the cloned parent). */
  childOriginalId: string;
  parentSourceId: string;
  order: number;
  keyParent: boolean;
  moduleData?: Record<string, unknown>;
}

export interface CloneRegionResult {
  /** Cloned node set in pre-order (parent always before child). */
  nodes: CloneRegionNode[];
  /** Every internal source edge (both endpoints in the cloned set). */
  internalEdges: CloneRegionEdge[];
  /** `link_to_original` edges: original child linked under cloned parent. */
  linkOriginal: CloneRegionLinkOriginal[];
}

export interface TemplateCloneVisitEntry {
  item: Item;
  parentInTree: string | null;
  cloneSetting: CloneSetting | null;
  order: number;
  keyParent: boolean;
  moduleData?: Record<string, unknown>;
}

export interface TemplateCloneLinkOriginalEdge {
  childOriginalId: string;
  parentInTree: string;
  order: number;
  keyParent: boolean;
  moduleData?: Record<string, unknown>;
}

export interface TemplateCloneVisitResult {
  ordered: TemplateCloneVisitEntry[];
  linkOriginal: TemplateCloneLinkOriginalEdge[];
}

export interface CollectCloneRegionOptions {
  /**
   * Roots of the region. exec/calendar apply-template: `[templateRoot]`.
   * The /records clone: `[recordId]` (include-root) or its direct child ids.
   */
  seedIds: string[];
  /**
   * Honour each SOURCE edge's `clone_setting === 'link_to_original'`
   * per-edge (exec, /records clone). When false the edge is cloned normally
   * (calendar — it has no clone_setting concept).
   */
  honorEdgeCloneSetting?: boolean;
  /**
   * Treat EVERY direct child of a seed as link_to_original regardless of the
   * edge's own clone_setting — the /records "link_to_original" mode (clone
   * only the seeds; link their original children under the cloned seed).
   */
  linkAllChildrenOfSeeds?: boolean;
}

/**
 * A clone region follows graph_child_of (tree) edges ONLY. `groups:` edges
 * (scope/group membership, where the parent is the group) must NOT be
 * traversed as tree children or recreated as tree edges — group membership
 * is handled separately by each consumer (and server-side by
 * fn::group_for_clone). This mirrors the old /records clone's childIdsOf
 * filter and the server's collect_clone_region.
 */
function isGroupsEdge(edge: { edge_id?: string }): boolean {
  return typeof edge.edge_id === 'string' && edge.edge_id.startsWith('groups:');
}

function normalizeEdge(child: {
  child_id: string;
  order?: number;
  is_key_parent?: boolean;
  clone_setting?: CloneSetting | null;
  module_data?: Record<string, unknown>;
}): { childId: string; order: number; keyParent: boolean; cloneSetting: CloneSetting | null; moduleData?: Record<string, unknown> } {
  return {
    childId: String(child.child_id),
    order: typeof child.order === 'number' ? child.order : 0,
    // Absent/undefined → primary parent (true). Only an explicit `false`
    // demotes. This is the single canonical rule (was divergent per surface).
    keyParent: child.is_key_parent !== false,
    cloneSetting: child.clone_setting ?? null,
    moduleData: child.module_data
  };
}

/**
 * Collect the clone region: the reachable node set (pre-order), every
 * internal graph_child_of edge with its preserved source attributes, and the
 * link_to_original relationships. Pure (no cache writes, no id allocation).
 */
export function collectCloneRegion(
  cache: CloneRegionCache,
  options: CollectCloneRegionOptions
): CloneRegionResult {
  const { seedIds, honorEdgeCloneSetting = false, linkAllChildrenOfSeeds = false } = options;
  const seedSet = new Set(seedIds.map(String));
  const visited = new Set<string>();
  const nodes: CloneRegionNode[] = [];
  const parentFirstReached = new Map<string, string | null>();
  const linkOriginal: CloneRegionLinkOriginal[] = [];

  // DFS that yields children in natural `order` (push reversed → pop in
  // order), matching the long-standing exec/calendar traversal exactly so
  // record creation order (and parent-before-child date threading) is
  // unchanged.
  const stack: Array<{ id: string; parentSourceId: string | null }> = [...seedIds]
    .reverse()
    .map((id) => ({ id: String(id), parentSourceId: null }));

  while (stack.length > 0) {
    const { id, parentSourceId } = stack.pop()!;
    if (visited.has(id)) continue;
    const item = cache.getItem(id);
    if (!item) continue;
    visited.add(id);
    nodes.push({ sourceId: id, parentSourceId });
    parentFirstReached.set(id, parentSourceId);

    const isSeed = seedSet.has(id);
    const children = cache.get_children_for_parent(id) ?? [];
    for (const raw of [...children].reverse()) {
      if (isGroupsEdge(raw)) continue; // tree edges only
      const e = normalizeEdge(raw);
      const linkThis =
        (honorEdgeCloneSetting && e.cloneSetting === 'link_to_original') ||
        (linkAllChildrenOfSeeds && isSeed);
      if (linkThis) {
        // Original child stays intact; link it under the cloned parent. Do
        // NOT descend.
        linkOriginal.push({
          childOriginalId: e.childId,
          parentSourceId: id,
          order: e.order,
          keyParent: e.keyParent,
          ...(e.moduleData ? { moduleData: e.moduleData } : {})
        });
        continue;
      }
      stack.push({ id: e.childId, parentSourceId: id });
    }
  }

  // Internal edges: every source child edge whose BOTH endpoints are in the
  // cloned set. For a template tree this equals the tree edges; for a DAG
  // region (the /records clone) it preserves cross-links — matching the
  // server's collect_clone_region. Emitted in node pre-order for stable
  // output.
  const internalEdges: CloneRegionEdge[] = [];
  for (const node of nodes) {
    const children = cache.get_children_for_parent(node.sourceId) ?? [];
    for (const raw of children) {
      if (isGroupsEdge(raw)) continue; // tree edges only
      const e = normalizeEdge(raw);
      if (!visited.has(e.childId)) continue; // child not cloned (e.g. link_to_original / out of region)
      internalEdges.push({
        parentSourceId: node.sourceId,
        childSourceId: e.childId,
        order: e.order,
        keyParent: e.keyParent,
        cloneSetting: e.cloneSetting,
        ...(e.moduleData ? { moduleData: e.moduleData } : {})
      });
    }
  }

  return { nodes, internalEdges, linkOriginal };
}

/**
 * Adapter for template-application flows. `collectCloneRegion` owns the graph
 * traversal; this attaches source items and the incoming edge metadata that
 * apply/preview code needs for date threading and batch edge construction.
 */
export function collectTemplateCloneVisits(
  cache: CloneRegionCache,
  rootItemId: string,
  options: { honorEdgeCloneSetting?: boolean } = {}
): TemplateCloneVisitResult {
  const region = collectCloneRegion(cache, {
    seedIds: [rootItemId],
    honorEdgeCloneSetting: options.honorEdgeCloneSetting === true
  });

  const incoming = new Map<string, CloneRegionEdge>();
  for (const edge of region.internalEdges) {
    incoming.set(edge.childSourceId, edge);
  }

  const ordered: TemplateCloneVisitEntry[] = [];
  for (const node of region.nodes) {
    const item = cache.getItem(node.sourceId);
    if (!item) continue;
    const inEdge = incoming.get(node.sourceId);
    ordered.push({
      item,
      parentInTree: node.parentSourceId,
      cloneSetting: inEdge?.cloneSetting ?? null,
      order: inEdge?.order ?? 0,
      keyParent: inEdge?.keyParent ?? true,
      ...(inEdge?.moduleData ? { moduleData: inEdge.moduleData } : {})
    });
  }

  return {
    ordered,
    linkOriginal: region.linkOriginal.map((edge) => ({
      childOriginalId: edge.childOriginalId,
      parentInTree: edge.parentSourceId,
      order: edge.order,
      keyParent: edge.keyParent,
      ...(edge.moduleData ? { moduleData: edge.moduleData } : {})
    }))
  };
}

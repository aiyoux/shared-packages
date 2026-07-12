export interface Item {
  id: string;
  profile_id?: string;
  text: string;
  markup?: string;
  children?: string[];
  /**
   * User-authored typed entries. NEVER contains server-computed values —
   * rollup opt-in is an authored `mode: 'rollup'` marker entry, and the
   * derived value lives in `computed_additionals`. The sync ingress
   * (fn::fix_additional_ids) strips any `computed: true` entry a client
   * sends.
   */
  additionals?: AdditionalWithId[];
  /**
   * Server-owned rollup values (pg/duration/distance/stock_level/
   * account_balance with `computed: true`). Read-only on the client: written
   * exclusively by the server rollup modules; any client write is ignored.
   * Read via `readComputedAdditionals` — never hand-roll access.
   */
  computed_additionals?: AdditionalWithId[];
  has_parent?: boolean;
  show_as_header?: boolean;
  parent?: string;
  /**
   * Clone/template lineage — PER-NODE provenance.
   *
   * INVARIANT: both of these are the id of THIS clone's own immediate
   * source record (the specific template node it was copied from). They are
   * NOT the template/container root, and NOT tree-wide. For a cloned tree,
   * every node carries a DIFFERENT pair pointing at its own source node.
   * In practice `original_template_id === copied_from_record`.
   *
   * This matches the original wisewords behaviour and the server clone
   * (`fn::group_for_clone`, `$original_source = NONE` →
   * `id AS copied_from_record`, `original_template_id`). Keep the client
   * clone paths (exec/calendar `apply-template-action`) in lockstep.
   *
   * ⚠️ ANTI-PATTERN — do NOT stamp the template *container root* here
   * tree-wide. That divergence (commit ba08375) broke VWT clone detection
   * (every nested descendant matched as a false "root"), made the field
   * path-dependent for every reader, and required this whole migration.
   *
   * Finding all clones of a template is a LOOKUP concern, not a stored
   * one: expand the template id to `{templateRoot} ∪ directChildren` and
   * match `copied_from_record INSIDE` that set — see
   * `fn::find_template_clones` (date_clone.surql), the `FetchTemplateClones`
   * RPC, and `vwt-logic.findCloneRoots`. The clone-parity integration
   * suite asserts this per-node invariant across both clone paths.
   */
  copied_from_record?: string;
  /** See `copied_from_record` above — same per-node invariant. */
  original_template_id?: string;
  svg?: string;
  short?: string;
  custom_color?: number;
  settings?: ItemSettings;
  module_settings?: Record<string, unknown>;
}

/**
 * A record as returned by a fetch/graph query — the stored `Item` plus the
 * relation fields that only exist when a query explicitly joined them
 * (`AS grouping`, `AS connections`, graph traversals, permission joins).
 *
 * Functions that need loaded relations must take `FetchedItem`, not `Item`,
 * so the type system tracks which fetch paths hydrated them: on a plain
 * `Item` these fields don't exist at all, and on a `FetchedItem` `undefined`
 * means "not loaded by this query" — which is NOT the same as "empty".
 * (See the permission-enrichment gotcha: some fetch paths join `user_public`
 * for username/avatar and some don't.)
 */
export interface FetchedItem extends Item {
  graph_children?: FetchedItem[];
  permissions?: ItemPermissions[];
  grouping?: FetchedItem[];
  connections?: FetchedItem[];
}

export interface ItemSettings {
  /** 'Full' (tree), 'Mini' (compact card), or a module-contributed key (e.g. 'calendar') */
  default_view?: string;
  /** 'Unset' | 'Paginate' | module-contributed display style key */
  display_style_graph?: string;
  /** 'Unset' | 'Paginate' | module-contributed display style key */
  display_style_group?: string;
}

export interface ItemPermissions {
  role: 'owner' | 'editor-adv' | 'editor' | 'viewer';
  user_id: string;
  username?: string;
  user_icon_small?: string;
}

/**
 * Authored opt-in to a server-side rollup: the record's derived value of the
 * marked type is computed from descendants into `computed_additionals`. The
 * marker carries the user CONFIG only (base type, weight, unit, currency…),
 * never a value.
 */
export type RollupMarkerAdditional = {
  type: 'pg' | 'duration' | 'distance' | 'stock_level' | 'account_balance';
  mode: 'rollup';
  weight?: number;
  desc?: string | null;
  /** pg: configured base/fallback progress type. */
  base_prog_type?: { ch?: string; pct?: number };
  /** pg: 'usr' (own base) or 'par' (inherit closest parent's type). */
  offset_base?: 'usr' | 'par';
  /** duration/distance: display unit for the computed value. */
  unit?: string;
  /** account_balance: the declared account currency. */
  currency?: string;
};

export type AdditionalValue =
  | RollupMarkerAdditional
  | { type: 'pg'; prog_type: { ch?: string; pct?: number }; weight?: number; computed?: boolean; desc?: string | null }
  | { type: 'date'; date_info: DateInformation; source_additional_id?: string }
  | { type: 'distance'; value: number; unit: string; meters: number; computed?: boolean; desc?: string | null }
  | { type: 'duration'; value: number; unit: string; seconds: number; computed?: boolean; desc?: string | null }
  | { type: 'transaction'; currency: string; amount_minor: number; debit_credit: 'debit' | 'credit'; transfer_id?: string; counterparty_tx_id?: string }
  | { type: 'account_balance'; currency: string; balance_minor: number; computed?: boolean }
  | { type: string; [key: string]: unknown };

export type AdditionalWithId = AdditionalValue & {
  id: string;
};

// The date-model types (DateInformation, TimeReference, RelevanceWindow,
// BaseOrVagueReference, StartOrEnd, WeekModeCode, RelevanceBound,
// RelevancePeriodUnit, DateReference) now live in @modular-app/ui/date and are
// re-exported from this package's barrel (`export * from '@modular-app/ui/date'`
// in index.ts). AdditionalValue below still references DateInformation, so
// import it here for local use only — do NOT re-export it from this file, or
// index.ts's `export *` (this file) and `export * from '@modular-app/ui/date'`
// would both star-export the same name and the spec would silently drop it.
import type { DateInformation } from '@modular-app/ui/date';

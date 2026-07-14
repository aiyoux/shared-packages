// Force Vite HMR
import type { Component } from 'svelte';

// ---------------------------------------------------------------------------
// ExtensionBag — module contribution registry (mirrors wisewords ExtensionBag)
// ---------------------------------------------------------------------------

/**
 * A module-contributed view that renders as a record's default_view.
 * Modules register these so the /records/{id} dispatcher can look them up.
 */
export interface ViewContribution {
  /** Unique key matching the default_view string stored on the record (e.g. 'calendar') */
  key: string;
  /** Human-readable name shown in the default_view selector UI */
  displayName: string;
  /** Svelte component to render. Must accept { rootId: string; runtime: AppRuntime } props */
  component: Component<any>;
}

/**
 * A module-contributed tab section shown in the record settings editor.
 */
export interface RecordSettingsSectionContribution {
  /** Tab label */
  displayName: string;
  /** Svelte component. Must accept { item: Item } props */
  component: Component<any>;
}

/**
 * Registry of module contributions — analogous to wisewords ExtensionBag.
 * Create with createExtensionBag(), then pass to each modules' extendExtensionBag().
 */
export interface ExtensionBag {
  /** Module-contributed views, keyed by their default_view key */
  views: Map<string, ViewContribution>;
  /** Module-contributed record settings tab sections */
  recordSettingsSections: RecordSettingsSectionContribution[];
}

/** Create a fresh, empty ExtensionBag to be populated by module contributions */
export function createExtensionBag(): ExtensionBag {
  return {
    views: new Map(),
    recordSettingsSections: [],
  };
}

export type ModuleVisibility = 'public' | 'private';

export interface ModulePageData {
  id: string;
  title: string;
  description: string;
  summary?: string;
  visibility?: ModuleVisibility;
  segments: string[];
  stats?: Array<{ label: string; value: string }>;
}

export interface AppModule {
  id: string;
  title: string;
  summary: string;
  visibility: ModuleVisibility;
  href: string;
  loadPage: () => Promise<{ default: Component<{ data: ModulePageData }> }>;
}

export interface BuildProfile {
  name: string;
  appTitle: string;
  modules: AppModule[];
}

export * from './types.ts';
export { createAppCache, type AppCache } from './cache/store.svelte.ts';
export * from './cache/hydration.ts';
export { type CacheItem, type CacheMutationEvent, type ChildEdge, type CloneSetting, type Op, type OpKind, type OpStatus, type SyncStatus, type EntityMeta, type CreateTreeBatchPayload, type CreateTreeBatchRecord, type CreateTreeBatchEdge, type CreateTreeBatchAppliesEdge, type CreateTreeBatchChildRef, type CreateTreeBatchGroupEdge, type CreateTreeBatchParentRef } from './cache/types.ts';
export { date_to_bucket_key, date_to_local_bucket, scope_bucket_key } from './cache/types.ts';
export {
  getSyncOpsStore,
  listSyncOps,
  listAllSyncOps,
  removeSyncOp,
  clearSyncOpsNamespace
} from './sync/ops-store.svelte.ts';
export {
  startFetch,
  endFetch,
  getFetchStore,
  listActiveFetches,
  listAllActiveFetches,
  totalActiveFetchCount,
  type FetchRecord
} from './sync/fetch-store.svelte.ts';
export {
  markSyncHealthy,
  markSyncDegraded,
  markSyncOffline,
  getSyncHealth,
  clearSyncHealth,
  type SyncHealthStatus,
  type SyncHealthState
} from './sync/sync-health.svelte.ts';
export * from './cache/persist.ts';
export {
  createLiveBus,
  type LiveBus,
  type LiveBusMsg
} from './sync/live.ts';
export { createSyncEngine, type SyncEngine } from './sync/engine.ts';
export { createAppRuntime, type AppRuntime, type RuntimeConfig } from './sync/runtime.ts';
export { type SurrealDbLiveConfig, type SurrealLiveConnection } from './sync/surrealdb-live.ts';
export { createLeaderElection, createTabLeaderElection, destroyTabLeaderElection, type LeaderElection } from './sync/leader.svelte.ts';
export { createLogger, type LogLevel } from './sync/logger.ts';
export { logLevelForProfile, type ProfileClass } from './sync/log-level.ts';
export { buildSurrealQuery, buildSurrealStatement, extractQueryRows } from './sync/surrealql.ts';
export * from './utils.ts';
// Date model (types + helpers) now lives in @modular-app/ui/date; re-exported
// here so existing `import { TimeReference, cloneTimeReference, MINUTE_MS, ... } from '@modular-app/module-sdk'` keeps working.
export * from '@modular-app/ui/date';
export * from './scheduler.ts';
export { resolveTemplateAdditionals, templateResolveContext, collectCloneRegion, collectTemplateCloneVisits } from './template-clone.ts';
export type {
  CloneRegionCache,
  CloneRegionNode,
  CloneRegionEdge,
  CloneRegionLinkOriginal,
  CloneRegionResult,
  CollectCloneRegionOptions,
  TemplateCloneLinkOriginalEdge,
  TemplateCloneVisitEntry,
  TemplateCloneVisitResult
} from './template-clone.ts';

export * from './scheduler/inventory.ts';
export * from './scheduler/medication.ts';
export * from './scheduler/money.ts';
export * from './scheduler/shopping.ts';
export * from './inventory-transactions.ts';
export {
  isDateAdditional,
  getDateAdditionalData,
  getDateAdditionalInfo,
  patchDateAdditional,
  patchDateAdditionalInfo
} from './date-additional.ts';
export {
  displayAsOf,
  getDateInfo,
  getPrimaryDateAdditional,
  isRelevanceInfinite,
  isStatus,
  normalizeDisplayAs,
  pinWhenOverdue,
  readDateInformation,
  relevanceMinutes,
  setDateAdditionalValue,
  type DateAdditionalEntry,
  type DisplayAs
} from './date-info.ts';
export {
  optimisticCacheItemFromItem,
  type OptimisticCacheItemOverrides
} from './optimistic-cache.ts';
export {
  isProgressAdditional,
  isRollupProgressMarker,
  getProgressAdditionalData,
  createProgressAdditional,
  patchProgressAdditional,
  readProgressAdditional,
  setProgressAdditionalComputed,
  setProgressAdditionalKind,
  setProgressAdditionalValue,
  setProgressAdditionalWeight,
  setProgressAdditionalDesc,
  type ProgressAdditionalData,
  type CheckProgressValue,
  type ProgressKind,
  type ProgressShape,
  type CreateProgressOptions
} from './progress-additional.ts';
export {
  isMeasureAdditional,
  isRollupMeasureMarker,
  readMeasureAdditional,
  createMeasureAdditional,
  setMeasureComputed,
  setMeasureValue,
  setMeasureUnit,
  setMeasureWeight,
  setMeasureDesc,
  toCanonical,
  fromCanonical,
  DISTANCE_UNITS,
  DURATION_UNITS,
  type MeasureKind,
  type MeasureUnit,
  type MeasureShape,
  type CreateMeasureOptions
} from './measure-additional.ts';

export {
  readComputedAdditionals,
  readComputedAdditional,
  isRollupMarker,
  resolveAdditionalForDisplay
} from './computed-additionals.ts';

export {
  applyAdditionalsMutation,
  mergeAdditionalsLocal,
  stampAdditionalUpdatedAt,
  type AdditionalsMutation,
  type AdditionalsMutationResult
} from './additionals-mutate.ts';

export {
  validateAdditionals,
  validateAdditionalEnvelope,
  additionalValidators
} from './additional-validate.ts';

export {
  readRef,
  readRefList,
  setRef,
  deleteRef,
  refsObject
} from './module-refs.ts';

export * from './dashboard.ts';

// Modular-app domain UI components + operation-feedback store. These lived in
// @modular-app/ui but were modular-app-specific (they depend on this package's
// record/additional model), so they moved here to let @modular-app/ui stay
// dependency-free. Re-exported so existing
// `import { ProgressEditor, pushOperation, ... } from '@modular-app/module-sdk'` works.
export { default as PartialReference } from './ui/PartialReference.svelte';
export { default as ApplyTemplatePopover } from './ui/ApplyTemplatePopover.svelte';
export { default as ProgressEditor } from './ui/ProgressEditor.svelte';
export { default as MeasureEditor } from './ui/MeasureEditor.svelte';
export { default as TransactionEditor } from './ui/TransactionEditor.svelte';
export { default as QuantityDeltaEditor } from './ui/QuantityDeltaEditor.svelte';
export { default as OperationFeedList } from './ui/OperationFeedList.svelte';
export { default as OperationStatusBadge } from './ui/OperationStatusBadge.svelte';
export { default as OperationStatusIndicator } from './ui/OperationStatusIndicator.svelte';
export {
  createOperation,
  pushOperation,
  updateOperation,
  completeOperation,
  failOperation,
  dismissOperation,
  clearOperations,
  getOperations,
  isOperationActiveStatus,
  matchesOperationStage,
  type OperationInput,
  type OperationQuery,
  type OperationRecord,
  type OperationStage,
  type OperationStatus,
  type OperationSurface
} from './ui/operation-feed.svelte.ts';

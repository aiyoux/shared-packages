import { SvelteMap } from 'svelte/reactivity';

export type OperationStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'canceled' | 'conflicted';
export type OperationSurface = 'activity-center' | 'inline';
export type OperationStage = 'all' | 'active' | 'done' | 'failed';

export interface OperationRecord {
  id: string;
  source: string;
  scope: string;
  kind: string;
  title: string;
  message: string | null;
  detail: string | null;
  status: OperationStatus;
  surfaces: OperationSurface[];
  context: string | null;
  subjectIds: string[];
  dedupeKey: string | null;
  dismissible: boolean;
  /**
   * Present when the underlying work can still be called off (e.g. a queued —
   * not yet inflight — sync op). The feed renders a Cancel button that invokes
   * it. Distinct from `dismissible`, which merely hides a settled entry.
   */
  cancel?: (() => void) | null;
  /**
   * Present when a FAILED/rejected operation can be attempted again (e.g. a
   * rejected sync op past its retry cap). The feed renders a Retry button
   * that invokes it. Mutually exclusive with `cancel` in practice — a
   * cancellable op is still queued, a retryable one has already settled.
   */
  retry?: (() => void) | null;
  /**
   * Present on a `conflicted` op (M10b field-stamps CAS conflict): resolves
   * it by force-overwriting the server's row with the local edit. Mutually
   * exclusive with `cancel`/`retry` — a conflicted op is settled, not queued
   * or rejected. Always paired with `takeTheirs`.
   */
  keepMine?: (() => void) | null;
  /**
   * Present on a `conflicted` op: resolves it by discarding the local edit
   * and adopting the server's current row. Always paired with `keepMine`.
   */
  takeTheirs?: (() => void) | null;
  count: number;
  firstAt: number;
  lastAt: number;
  profileId: string;
}

export interface OperationInput {
  source: string;
  scope: string;
  kind: string;
  title: string;
  message?: string | null;
  detail?: string | null;
  status: OperationStatus;
  surfaces?: OperationSurface[];
  context?: string | null;
  subjectIds?: string[];
  dedupeKey?: string | null;
  dismissible?: boolean;
  cancel?: (() => void) | null;
  retry?: (() => void) | null;
  keepMine?: (() => void) | null;
  takeTheirs?: (() => void) | null;
  profileId?: string;
}

export interface OperationQuery {
  profileId?: string;
  scope?: string;
  context?: string;
  surface?: OperationSurface;
  stage?: OperationStage;
  statuses?: OperationStatus[];
  limit?: number;
}

const GLOBAL_KEY = '__global__';
const MAX_OPERATIONS_PER_PROFILE = 100;
let operationsByProfile = new SvelteMap<string, OperationRecord[]>();

function profileKey(profileId?: string | null): string {
  return profileId || GLOBAL_KEY;
}

function operationKey(input: Pick<OperationInput, 'source' | 'scope' | 'kind' | 'status' | 'context' | 'title'>): string {
  return `${input.source}:${input.scope}:${input.kind}:${input.status}:${input.context ?? ''}:${input.title}`;
}

function makeOperationRecord(input: OperationInput, id: string, now: number): OperationRecord {
  return {
    id,
    source: input.source,
    scope: input.scope,
    kind: input.kind,
    title: input.title,
    message: input.message ?? null,
    detail: input.detail ?? null,
    status: input.status,
    surfaces: input.surfaces?.length ? [...input.surfaces] : ['activity-center'],
    context: input.context ?? null,
    subjectIds: [...(input.subjectIds ?? [])],
    dedupeKey: input.dedupeKey ?? null,
    dismissible: input.dismissible ?? true,
    cancel: input.cancel ?? null,
    retry: input.retry ?? null,
    keepMine: input.keepMine ?? null,
    takeTheirs: input.takeTheirs ?? null,
    count: 1,
    firstAt: now,
    lastAt: now,
    profileId: profileKey(input.profileId)
  };
}

function trimOperations(profileId: string, operations: OperationRecord[]): void {
  operationsByProfile.set(profileId, operations.slice(0, MAX_OPERATIONS_PER_PROFILE));
}

function updateOperationList(
  targetProfile: string,
  updater: (existing: OperationRecord[]) => OperationRecord[]
): void {
  const existing = operationsByProfile.get(targetProfile) ?? [];
  const next = updater(existing).sort((a, b) => b.lastAt - a.lastAt);
  trimOperations(targetProfile, next);
}

function findOperationProfile(id: string, explicitProfileId?: string): string | null {
  if (explicitProfileId) {
    const key = profileKey(explicitProfileId);
    return (operationsByProfile.get(key) ?? []).some((operation) => operation.id === id) ? key : null;
  }

  for (const [key, operations] of operationsByProfile) {
    if (operations.some((operation) => operation.id === id)) {
      return key;
    }
  }
  return null;
}

export function isOperationActiveStatus(status: OperationStatus): boolean {
  return status === 'queued' || status === 'running';
}

export function matchesOperationStage(operation: OperationRecord, stage: OperationStage): boolean {
  if (stage === 'all') return true;
  if (stage === 'active') return isOperationActiveStatus(operation.status);
  // 'conflicted' shares the 'failed' stage bucket — both need the user's
  // attention and neither is active or settled-clean.
  if (stage === 'failed') return operation.status === 'failed' || operation.status === 'conflicted';
  return operation.status === 'succeeded' || operation.status === 'canceled';
}

export function pushOperation(input: OperationInput): string {
  const now = Date.now();
  const targetProfile = profileKey(input.profileId);
  const existing = operationsByProfile.get(targetProfile) ?? [];
  const matchIndex = existing.findIndex((operation) => {
    if (input.dedupeKey && operation.dedupeKey) {
      return operation.dedupeKey === input.dedupeKey;
    }
    return operationKey(operation) === operationKey(input);
  });

  if (matchIndex >= 0) {
    const matched = existing[matchIndex];
    const updated: OperationRecord = {
      ...matched,
      title: input.title,
      message: input.message ?? matched.message,
      detail: input.detail ?? matched.detail,
      status: input.status,
      surfaces: input.surfaces?.length ? [...input.surfaces] : matched.surfaces,
      context: input.context ?? matched.context,
      subjectIds: input.subjectIds ? [...input.subjectIds] : matched.subjectIds,
      dismissible: input.dismissible ?? matched.dismissible,
      cancel: input.cancel !== undefined ? input.cancel : matched.cancel,
      retry: input.retry !== undefined ? input.retry : matched.retry,
      dedupeKey: input.dedupeKey ?? matched.dedupeKey,
      count: matched.count + 1,
      lastAt: now
    };
    updateOperationList(targetProfile, (records) => [
      updated,
      ...records.filter((record) => record.id !== matched.id)
    ]);
    return matched.id;
  }

  const id = crypto.randomUUID();
  const operation = makeOperationRecord(input, id, now);
  updateOperationList(targetProfile, (records) => [operation, ...records]);
  return id;
}

export function createOperation(input: Omit<OperationInput, 'status'> & { status?: OperationStatus }): string {
  return pushOperation({
    ...input,
    status: input.status ?? 'queued'
  });
}

export function updateOperation(
  id: string,
  patch: Partial<Omit<OperationRecord, 'id' | 'count' | 'firstAt' | 'lastAt' | 'profileId'>>,
  profileId?: string
): void {
  const targetProfile = findOperationProfile(id, profileId);
  if (!targetProfile) return;
  updateOperationList(targetProfile, (records) =>
    records.map((operation) =>
      operation.id === id
        ? {
            ...operation,
            ...patch,
            surfaces: patch.surfaces ? [...patch.surfaces] : operation.surfaces,
            subjectIds: patch.subjectIds ? [...patch.subjectIds] : operation.subjectIds,
            lastAt: Date.now()
          }
        : operation
    )
  );
}

export function completeOperation(
  id: string,
  patch: Partial<Omit<OperationRecord, 'id' | 'count' | 'firstAt' | 'lastAt' | 'profileId' | 'status'>> = {},
  profileId?: string
): void {
  updateOperation(id, { ...patch, status: 'succeeded' }, profileId);
}

export function failOperation(
  id: string,
  patch: Partial<Omit<OperationRecord, 'id' | 'count' | 'firstAt' | 'lastAt' | 'profileId' | 'status'>> = {},
  profileId?: string
): void {
  updateOperation(id, { ...patch, status: 'failed' }, profileId);
}

export function dismissOperation(id: string, profileId?: string): void {
  const targetProfile = findOperationProfile(id, profileId);
  if (!targetProfile) return;
  updateOperationList(targetProfile, (records) => records.filter((operation) => operation.id !== id));
}

export function clearOperations(profileId?: string): void {
  if (profileId) {
    operationsByProfile.delete(profileKey(profileId));
    return;
  }
  operationsByProfile.clear();
}

export function getOperations(query: OperationQuery = {}): OperationRecord[] {
  const all: OperationRecord[] = [];
  if (query.profileId) {
    all.push(...(operationsByProfile.get(profileKey(query.profileId)) ?? []));
    all.push(...(operationsByProfile.get(GLOBAL_KEY) ?? []).filter((operation) => operation.profileId === GLOBAL_KEY));
  } else {
    for (const operations of operationsByProfile.values()) {
      all.push(...operations);
    }
  }

  const filtered = all
    .filter((operation) => (query.scope ? operation.scope === query.scope : true))
    .filter((operation) => (query.context ? operation.context === query.context : true))
    .filter((operation) => (query.surface ? operation.surfaces.includes(query.surface) : true))
    .filter((operation) => (query.statuses?.length ? query.statuses.includes(operation.status) : true))
    .filter((operation) => matchesOperationStage(operation, query.stage ?? 'all'))
    .sort((a, b) => b.lastAt - a.lastAt);

  return typeof query.limit === 'number' ? filtered.slice(0, query.limit) : filtered;
}

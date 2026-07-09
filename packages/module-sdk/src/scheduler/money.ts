import type { AppRuntime } from '../sync/runtime.ts';
import { readComputedAdditional } from '../computed-additionals.ts';
import { readRef } from '../module-refs.ts';
import type { AdditionalWithId, Item } from '../types.ts';
import {
  asDate,
  asFiniteNumber,
  inventoryModuleSettings,
  normalizeCurrency as normalizeCurrencyCode,
  normalizeRecordId
} from '../scheduler.ts';
import { shoppingLineItemConfig } from './shopping.ts';

export type MoneyAccountKind = 'cash' | 'bank' | 'credit' | 'savings' | 'other';
export type FinancialTransactionStatus = 'suggested' | 'draft' | 'posted' | 'void';
export type DebitCredit = 'debit' | 'credit';

export interface MoneyAccountConfig {
  currency?: string | null;
  account_kind?: MoneyAccountKind | string | null;
  archived?: boolean | null;
  label?: string | null;
}

export interface FinancialTransactionConfig {
  account_id?: string | null;
  currency?: string | null;
  amount_minor?: number | null;
  debit_credit?: DebitCredit | string | null;
  posted_at?: string | null;
  status?: FinancialTransactionStatus | string | null;
  category_record_id?: string | null;
  memo?: string | null;
  source_record_id?: string | null;
  source_module?: string | null;
}

export interface FinancialTransaction {
  record_id: string;
  account_id: string;
  currency: string;
  amount_minor: number;
  debit_credit: DebitCredit;
  signed_minor: number;
  posted_at: string;
  status: FinancialTransactionStatus;
  category_record_id?: string | null;
  memo?: string | null;
  source_record_id?: string | null;
  source_module?: string | null;
}

export interface MoneyAccountState {
  item: Item;
  account_id: string;
  label: string;
  currency: string;
  account_kind: MoneyAccountKind | string;
  archived: boolean;
  balance_minor: number;
  posted_balance_minor: number;
  computed_balance_minor?: number | null;
  transactions: FinancialTransaction[];
  posted_transactions: FinancialTransaction[];
  suggested_transactions: FinancialTransaction[];
}

export interface PurchaseCandidate {
  source_record_id: string;
  source_module: 'inventory' | 'medication' | 'shopping';
  stock_item_id?: string | null;
  stock_label?: string | null;
  source_item_id?: string | null;
  label: string;
  memo: string;
  transacted_at: string;
  quantity_delta: number;
  amount_minor?: number | null;
  currency?: string | null;
  note?: string | null;
}

export function moneyModuleSettings(item: Item): Record<string, unknown> {
  return (item.module_settings?.money_module ?? {}) as Record<string, unknown>;
}

export function moneyAccountConfig(item: Item): MoneyAccountConfig | null {
  const config = moneyModuleSettings(item).account;
  return config && typeof config === 'object' ? (config as MoneyAccountConfig) : null;
}

export function financialTransactionConfig(item: Item): FinancialTransactionConfig | null {
  const config = moneyModuleSettings(item).financial_transaction;
  if (!config || typeof config !== 'object') return null;
  // Record references live under the reserved refs object (module-refs.ts);
  // surface them flat so downstream logic keeps one shape.
  const ns = config as Record<string, unknown>;
  return {
    ...(ns as FinancialTransactionConfig),
    account_id: readRef(ns, 'account_id') ?? (ns.account_id as string | null | undefined) ?? null,
    source_record_id: readRef(ns, 'source_record_id') ?? (ns.source_record_id as string | null | undefined) ?? null
  };
}

// Money always resolves to a concrete currency, defaulting to USD.
function normalizeCurrency(value: unknown, fallback = 'USD'): string {
  return normalizeCurrencyCode(value, fallback);
}

function normalizeDebitCredit(value: unknown): DebitCredit | null {
  return value === 'debit' || value === 'credit' ? value : null;
}

function normalizeStatus(value: unknown): FinancialTransactionStatus {
  if (value === 'posted' || value === 'suggested' || value === 'draft' || value === 'void') {
    return value;
  }
  return 'draft';
}

function signedMinor(amountMinor: number, debitCredit: DebitCredit): number {
  return debitCredit === 'credit' ? amountMinor : -amountMinor;
}

function transactionAdditional(item: Item): AdditionalWithId | null {
  return item.additionals?.find((additional) => additional.type === 'transaction') ?? null;
}

function recordTimestamp(item: Item): string | null {
  const raw = item as Item & { created?: string | null; updated?: string | null };
  return raw.updated ?? raw.created ?? null;
}

function accountBalanceAdditional(item: Item, currency: string): AdditionalWithId | null {
  return readComputedAdditional(item, 'account_balance', currency);
}

export function buildTransactionAdditional(args: {
  currency: string;
  amount_minor: number;
  debit_credit: DebitCredit;
  id?: string;
}): AdditionalWithId {
  return {
    id: args.id ?? crypto.randomUUID(),
    type: 'transaction',
    currency: normalizeCurrency(args.currency),
    amount_minor: Math.max(0, Math.round(args.amount_minor)),
    debit_credit: args.debit_credit
  } as AdditionalWithId;
}

/**
 * Authored account MARKER: declares the record an account for the given
 * currency. The server accumulates the actual balance VALUE (per currency)
 * into the server-owned computed_additionals field — clients never write it.
 */
export function buildAccountBalanceAdditional(args: {
  currency: string;
  id?: string;
}): AdditionalWithId {
  return {
    id: args.id ?? crypto.randomUUID(),
    type: 'account_balance',
    mode: 'rollup',
    currency: normalizeCurrency(args.currency)
  } as unknown as AdditionalWithId;
}

export function postedAdditionalsForFinancialTransaction(
  current: AdditionalWithId[] | null | undefined,
  transaction: Pick<FinancialTransactionConfig, 'currency' | 'amount_minor' | 'debit_credit'>
): AdditionalWithId[] {
  const existing = current ?? [];
  const existingTx = existing.find((additional) => additional.type === 'transaction');
  const debitCredit = normalizeDebitCredit(transaction.debit_credit) ?? 'debit';
  const amountMinor = Math.max(0, Math.round(asFiniteNumber(transaction.amount_minor) ?? 0));
  const nextTx = buildTransactionAdditional({
    id: existingTx?.id,
    currency: normalizeCurrency(transaction.currency),
    amount_minor: amountMinor,
    debit_credit: debitCredit
  });
  return [...existing.filter((additional) => additional.type !== 'transaction'), nextTx];
}

export function unpostedAdditionalsForFinancialTransaction(
  current: AdditionalWithId[] | null | undefined
): AdditionalWithId[] {
  return (current ?? []).filter((additional) => additional.type !== 'transaction');
}

export function collectFinancialTransactionItems(
  accountId: string,
  items: Item[],
  runtime: AppRuntime | null | undefined
): Item[] {
  const wantedId = normalizeRecordId(accountId) ?? accountId;
  const out = new Map<string, Item>();

  if (runtime) {
    for (const edge of runtime.cache.get_children_for_parent(wantedId)) {
      const item = runtime.cache.getItem(edge.child_id) as Item | undefined;
      if (!item) continue;
      const config = financialTransactionConfig(item);
      if (!config) continue;
      const linkedId = normalizeRecordId(config.account_id ?? null) ?? wantedId;
      if (linkedId !== wantedId) continue;
      out.set(String(item.id), item);
    }
  }

  for (const item of items) {
    const config = financialTransactionConfig(item);
    if (!config) continue;
    const linkedId = normalizeRecordId(config.account_id ?? item.parent ?? null);
    if (linkedId !== wantedId) continue;
    out.set(String(item.id), item);
  }

  return [...out.values()];
}

export function normalizeFinancialTransaction(
  item: Item,
  fallbackAccountId: string
): FinancialTransaction | null {
  const config = financialTransactionConfig(item);
  if (!config) return null;

  // Monetary facts come from the `transaction` additional (the single source
  // of truth the server balance rollup reads). The config fallback only
  // tolerates legacy/hand-built records — current builders never write these
  // fields into module_settings.
  const additional = transactionAdditional(item) as Record<string, unknown> | null;
  const amountMinor = asFiniteNumber(additional?.amount_minor ?? config.amount_minor);
  const debitCredit = normalizeDebitCredit(additional?.debit_credit ?? config.debit_credit);
  const postedAt = asDate(config.posted_at ?? recordTimestamp(item));
  if (amountMinor == null || amountMinor < 0 || !debitCredit || !postedAt) return null;

  const accountId = normalizeRecordId(config.account_id ?? fallbackAccountId) ?? fallbackAccountId;
  const status = normalizeStatus(config.status ?? (additional ? 'posted' : 'draft'));

  return {
    record_id: String(item.id),
    account_id: accountId,
    currency: normalizeCurrency(additional?.currency ?? config.currency),
    amount_minor: Math.round(amountMinor),
    debit_credit: debitCredit,
    signed_minor: signedMinor(Math.round(amountMinor), debitCredit),
    posted_at: postedAt.toISOString(),
    status,
    category_record_id: normalizeRecordId(config.category_record_id ?? null),
    memo: typeof config.memo === 'string' ? config.memo : null,
    source_record_id: normalizeRecordId(config.source_record_id ?? null),
    source_module: typeof config.source_module === 'string' ? config.source_module : null
  };
}

export function deriveMoneyAccountStates(
  items: Item[],
  context: { runtime?: AppRuntime | null | undefined } = {}
): MoneyAccountState[] {
  const out: MoneyAccountState[] = [];

  const accountItems = items.filter((item) => Boolean(moneyAccountConfig(item)));

  // Bucket transactions per account in one pass over the items (plus indexed
  // child-edge lookups) instead of rescanning the full array per account.
  const accountIds = new Set(
    accountItems.map((item) => normalizeRecordId(String(item.id)) ?? String(item.id))
  );
  const transactionsByAccount = new Map<string, Map<string, Item>>();
  const addTransaction = (accountId: string, item: Item) => {
    const bucket = transactionsByAccount.get(accountId) ?? new Map<string, Item>();
    bucket.set(String(item.id), item);
    transactionsByAccount.set(accountId, bucket);
  };
  for (const item of items) {
    const config = financialTransactionConfig(item);
    if (!config) continue;
    const linkedId = normalizeRecordId(config.account_id ?? item.parent ?? null);
    if (linkedId && accountIds.has(linkedId)) addTransaction(linkedId, item);
  }
  if (context.runtime) {
    for (const accountId of accountIds) {
      for (const edge of context.runtime.cache.get_children_for_parent(accountId)) {
        const item = context.runtime.cache.getItem(edge.child_id) as Item | undefined;
        if (!item) continue;
        const config = financialTransactionConfig(item);
        if (!config) continue;
        const linkedId = normalizeRecordId(config.account_id ?? null) ?? accountId;
        if (linkedId !== accountId) continue;
        addTransaction(accountId, item);
      }
    }
  }

  for (const item of accountItems) {
    const account = moneyAccountConfig(item);
    if (!account) continue;

    const accountId = String(item.id);
    const normalizedAccountId = normalizeRecordId(accountId) ?? accountId;
    const currency = normalizeCurrency(account.currency);
    const transactions = [...(transactionsByAccount.get(normalizedAccountId)?.values() ?? [])]
      .map((transactionItem) => normalizeFinancialTransaction(transactionItem, accountId))
      .filter((transaction): transaction is FinancialTransaction => Boolean(transaction))
      .sort((left, right) =>
        left.posted_at < right.posted_at ? -1 : left.posted_at > right.posted_at ? 1 : 0
      );
    const postedTransactions = transactions.filter((transaction) => transaction.status === 'posted');
    const suggestedTransactions = transactions.filter((transaction) => transaction.status === 'suggested');
    const postedBalanceMinor = postedTransactions
      .filter((transaction) => transaction.currency === currency)
      .reduce((sum, transaction) => sum + transaction.signed_minor, 0);
    const computedAdditional = accountBalanceAdditional(item, currency) as Record<string, unknown> | null;
    const computedBalanceMinor = asFiniteNumber(computedAdditional?.balance_minor);

    out.push({
      item,
      account_id: accountId,
      label:
        typeof account.label === 'string' && account.label.trim().length > 0
          ? account.label.trim()
          : item.text?.trim() || accountId,
      currency,
      account_kind:
        typeof account.account_kind === 'string' && account.account_kind.trim().length > 0
          ? account.account_kind.trim()
          : 'other',
      archived: account.archived === true,
      balance_minor: postedBalanceMinor,
      posted_balance_minor: postedBalanceMinor,
      computed_balance_minor: computedBalanceMinor,
      transactions,
      posted_transactions: postedTransactions,
      suggested_transactions: suggestedTransactions
    });
  }

  return out.sort((left, right) => left.label.localeCompare(right.label));
}

function postedMoneySourceIds(items: Item[]): Set<string> {
  const out = new Set<string>();
  for (const item of items) {
    const tx = normalizeFinancialTransaction(item, '');
    if (!tx || tx.status !== 'posted' || !tx.source_record_id) continue;
    out.add(tx.source_record_id);
  }
  return out;
}

function isMedicationSource(sourceItem: Item | undefined): boolean {
  return Boolean(sourceItem?.module_settings?.medication_module);
}

export function derivePurchaseCandidates(
  items: Item[],
  runtime: AppRuntime | null | undefined
): PurchaseCandidate[] {
  const postedSources = postedMoneySourceIds(items);
  const itemById = new Map(items.map((item) => [String(item.id), item]));
  const out: PurchaseCandidate[] = [];

  for (const item of items) {
    const inventory = inventoryModuleSettings(item).stock_transaction as Record<string, unknown> | undefined;
    if (!inventory || typeof inventory !== 'object') continue;
    if (inventory.transaction_kind !== 'restock') continue;

    const sourceRecordId = normalizeRecordId(String(item.id)) ?? String(item.id);
    if (postedSources.has(sourceRecordId)) continue;

    const transactedAt = asDate(
      typeof inventory.transacted_at === 'string' || inventory.transacted_at instanceof Date
        ? inventory.transacted_at
        : recordTimestamp(item)
    );
    const quantityDelta = asFiniteNumber(inventory.quantity_delta);
    if (!transactedAt || quantityDelta == null || quantityDelta <= 0) continue;

    const stockItemId = normalizeRecordId(inventory.stock_item_id as string | null | undefined);
    const stockItem = stockItemId
      ? (runtime?.cache.getItem(stockItemId) as Item | undefined) ?? itemById.get(stockItemId)
      : undefined;
    const sourceItemId = normalizeRecordId(inventory.source_record_id as string | null | undefined);
    const sourceItem = sourceItemId
      ? (runtime?.cache.getItem(sourceItemId) as Item | undefined) ?? itemById.get(sourceItemId)
      : undefined;
    const shoppingLine = sourceItem ? shoppingLineItemConfig(sourceItem) : null;
    const sourceModule = shoppingLine ? 'shopping' : isMedicationSource(sourceItem) ? 'medication' : 'inventory';
    const stockLabel = stockItem?.text?.trim() || null;
    const label = item.text?.trim() || `${stockLabel ?? 'Inventory'} restock`;
    const note = typeof inventory.note === 'string' ? inventory.note : null;
    const amountMinor = asFiniteNumber(shoppingLine?.amount_minor);
    const currency = typeof shoppingLine?.currency === 'string' && shoppingLine.currency.trim()
      ? shoppingLine.currency.trim().toUpperCase()
      : null;

    out.push({
      source_record_id: sourceRecordId,
      source_module: sourceModule,
      stock_item_id: stockItemId,
      stock_label: stockLabel,
      source_item_id: sourceItemId,
      label,
      memo: note || label,
      transacted_at: transactedAt.toISOString(),
      quantity_delta: quantityDelta,
      amount_minor: amountMinor != null && amountMinor >= 0 ? Math.round(amountMinor) : null,
      currency,
      note
    });
  }

  for (const item of items) {
    const shoppingLine = shoppingLineItemConfig(item);
    if (!shoppingLine) continue;
    const sourceRecordId = normalizeRecordId(String(item.id)) ?? String(item.id);
    if (postedSources.has(sourceRecordId)) continue;
    if (shoppingLine.status !== 'purchased') continue;
    if (shoppingLine.purchase_mode !== 'purchase_only') continue;
    if (shoppingLine.inventory_transaction_id) continue;

    const purchasedAt = asDate(shoppingLine.purchased_at ?? null);
    const quantity = shoppingLine.quantity && typeof shoppingLine.quantity === 'object'
      ? asFiniteNumber((shoppingLine.quantity as unknown as Record<string, unknown>).value)
      : null;
    const amountMinor = asFiniteNumber(shoppingLine.amount_minor);
    const currency = typeof shoppingLine.currency === 'string' && shoppingLine.currency.trim()
      ? shoppingLine.currency.trim().toUpperCase()
      : null;
    const label = shoppingLine.label?.trim() || item.text?.trim() || 'Shopping purchase';

    out.push({
      source_record_id: sourceRecordId,
      source_module: 'shopping',
      stock_item_id: normalizeRecordId(shoppingLine.inventory_stock_item_id ?? null),
      stock_label: null,
      source_item_id: null,
      label,
      memo: label,
      transacted_at: purchasedAt?.toISOString() ?? new Date(0).toISOString(),
      quantity_delta: quantity ?? 1,
      amount_minor: amountMinor != null && amountMinor >= 0 ? Math.round(amountMinor) : null,
      currency
    });
  }

  return out.sort((left, right) =>
    left.transacted_at < right.transacted_at ? -1 : left.transacted_at > right.transacted_at ? 1 : 0
  );
}

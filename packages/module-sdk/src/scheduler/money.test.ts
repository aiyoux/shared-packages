import { describe, expect, it } from 'vitest';
import {
  buildAccountBalanceAdditional,
  buildTransactionAdditional,
  deriveMoneyAccountStates,
  derivePurchaseCandidates,
  postedAdditionalsForFinancialTransaction,
  unpostedAdditionalsForFinancialTransaction
} from './money.ts';
import type { Item } from '../types.ts';

// Mirrors of the server-side balance-propagation predicates in
// surql/runtime/progress_calculation/modules/balance.surql. The server only
// rolls a child's amount into the account's computed balance when the child
// carries a `transaction` additional this predicate accepts, and only
// materializes the balance on accounts whose `account_balance` additional this
// one accepts. These tests lock the client emission to that contract so a
// refactor of the additional shape can't silently disable server rollup.
function serverAcceptsTransactionAdditional(tx: any): boolean {
  if (!tx || tx.type !== 'transaction') return false;
  const currency = String(tx.currency ?? '').toUpperCase();
  const amountMinor = Number.parseInt(String(tx.amount_minor ?? -1), 10);
  const dc = String(tx.debit_credit ?? '').toLowerCase();
  return currency !== '' && Number.isFinite(amountMinor) && amountMinor >= 0 && (dc === 'debit' || dc === 'credit');
}

// Mirrors fn::is_valid_account_balance_additional: client-authored
// account_balance entries must be account MARKERS (mode: 'rollup', non-empty
// currency, no value fields). The balance VALUE is server-owned.
function serverAcceptsAccountBalanceAdditional(ab: any): boolean {
  if (!ab || ab.type !== 'account_balance') return false;
  const currency = String(ab.currency ?? '').toUpperCase();
  return currency !== '' && ab.mode === 'rollup' && ab.balance_minor === undefined;
}

describe('money ledger derivation', () => {
  it('discovers account records and excludes suggested transactions from balances', () => {
    const items: Item[] = [
      {
        id: 'records:cash',
        text: 'Cash wallet',
        additionals: [
          {
            id: 'bal-1',
            type: 'account_balance',
            mode: 'rollup',
            currency: 'USD'
          } as any
        ],
        computed_additionals: [
          {
            id: 'bal-v-1',
            type: 'account_balance',
            currency: 'USD',
            balance_minor: 0,
            computed: true
          } as any
        ],
        module_settings: {
          money_module: {
            account: {
              currency: 'USD',
              account_kind: 'cash',
              archived: false
            }
          }
        }
      },
      {
        id: 'records:income',
        text: 'Pay',
        parent: 'records:cash',
        additionals: [
          {
            id: 'tx-1',
            type: 'transaction',
            currency: 'USD',
            amount_minor: 10000,
            debit_credit: 'credit'
          } as any
        ],
        module_settings: {
          money_module: {
            // Monetary facts live in the `transaction` additional above — not
            // duplicated here. module_settings holds only bookkeeping fields.
            financial_transaction: {
              account_id: 'records:cash',
              posted_at: '2026-04-22T00:00:00.000Z',
              status: 'posted'
            }
          }
        }
      },
      {
        id: 'records:suggested',
        text: 'Potential grocery spend',
        parent: 'records:cash',
        module_settings: {
          money_module: {
            financial_transaction: {
              account_id: 'records:cash',
              currency: 'USD',
              amount_minor: 2500,
              debit_credit: 'debit',
              posted_at: '2026-04-22T01:00:00.000Z',
              status: 'suggested'
            }
          }
        }
      }
    ];

    const [state] = deriveMoneyAccountStates(items);

    expect(state?.account_id).toBe('records:cash');
    expect(state?.transactions).toHaveLength(2);
    expect(state?.posted_transactions).toHaveLength(1);
    expect(state?.suggested_transactions).toHaveLength(1);
    expect(state?.balance_minor).toBe(10000);
    expect(state?.computed_balance_minor).toBe(0);
  });

  it('derives purchase candidates from unmatched inventory restocks only', () => {
    const items: Item[] = [
      {
        id: 'records:stock',
        text: 'Pantry stock',
        module_settings: {
          inventory_module: {
            stock_item: {
              counted_quantity: 1
            }
          }
        }
      },
      {
        id: 'records:restock',
        text: 'Restock pantry',
        module_settings: {
          inventory_module: {
            stock_transaction: {
              stock_item_id: 'records:stock',
              quantity_delta: 5,
              transacted_at: '2026-04-22T00:00:00.000Z',
              transaction_kind: 'restock',
              note: 'Groceries'
            }
          }
        }
      },
      {
        id: 'records:consume',
        text: 'Consume pantry',
        module_settings: {
          inventory_module: {
            stock_transaction: {
              stock_item_id: 'records:stock',
              quantity_delta: -1,
              transacted_at: '2026-04-22T01:00:00.000Z',
              transaction_kind: 'consumption'
            }
          }
        }
      },
      {
        id: 'records:matched-restock',
        text: 'Matched restock',
        module_settings: {
          inventory_module: {
            stock_transaction: {
              stock_item_id: 'records:stock',
              quantity_delta: 3,
              transacted_at: '2026-04-22T02:00:00.000Z',
              transaction_kind: 'restock'
            }
          }
        }
      },
      {
        id: 'records:posted-money',
        text: 'Posted purchase',
        additionals: [
          {
            id: 'tx-2',
            type: 'transaction',
            currency: 'USD',
            amount_minor: 1200,
            debit_credit: 'debit'
          } as any
        ],
        module_settings: {
          money_module: {
            financial_transaction: {
              account_id: 'records:cash',
              posted_at: '2026-04-22T02:30:00.000Z',
              status: 'posted',
              source_record_id: 'records:matched-restock',
              source_module: 'inventory'
            }
          }
        }
      }
    ];

    const candidates = derivePurchaseCandidates(items, null);

    expect(candidates).toHaveLength(1);
    expect(candidates[0]).toMatchObject({
      source_record_id: 'records:restock',
      source_module: 'inventory',
      stock_item_id: 'records:stock',
      memo: 'Groceries',
      quantity_delta: 5
    });
  });

  it('identifies medication refills through inventory restock source records', () => {
    const items: Item[] = [
      {
        id: 'records:med',
        text: 'Medication',
        module_settings: {
          medication_module: {
            medication: {
              effective_units_per_day: 1
            }
          }
        }
      },
      {
        id: 'records:refill',
        text: 'Medication refill',
        module_settings: {
          inventory_module: {
            stock_transaction: {
              stock_item_id: 'records:stock-med',
              quantity_delta: 30,
              transacted_at: '2026-04-22T00:00:00.000Z',
              transaction_kind: 'restock',
              source_record_id: 'records:med',
              note: 'Medication refill'
            }
          }
        }
      }
    ];

    const [candidate] = derivePurchaseCandidates(items, null);

    expect(candidate?.source_record_id).toBe('records:refill');
    expect(candidate?.source_item_id).toBe('records:med');
    expect(candidate?.source_module).toBe('medication');
  });

  it('carries shopping costs through inventory restock purchase candidates', () => {
    const items: Item[] = [
      {
        id: 'records:shopping-line',
        text: 'Milk',
        module_settings: {
          shopping_module: {
            line_item: {
              status: 'purchased',
              label: 'Milk',
              purchase_mode: 'restock_inventory',
              amount_minor: 599,
              currency: 'usd'
            }
          }
        }
      },
      {
        id: 'records:restock',
        text: 'Milk purchased',
        module_settings: {
          inventory_module: {
            stock_transaction: {
              stock_item_id: 'records:stock',
              quantity_delta: 2,
              transacted_at: '2026-04-22T00:00:00.000Z',
              transaction_kind: 'restock',
              source_record_id: 'records:shopping-line',
              note: 'Shopping purchase'
            }
          }
        }
      }
    ];

    const [candidate] = derivePurchaseCandidates(items, null);

    expect(candidate).toMatchObject({
      source_record_id: 'records:restock',
      source_module: 'shopping',
      source_item_id: 'records:shopping-line',
      amount_minor: 599,
      currency: 'USD'
    });
  });

  it('derives purchase-only shopping lines as purchase candidates', () => {
    const items: Item[] = [
      {
        id: 'records:line',
        text: 'Napkins',
        module_settings: {
          shopping_module: {
            line_item: {
              status: 'purchased',
              label: 'Napkins',
              purchase_mode: 'purchase_only',
              purchased_at: '2026-04-22T00:00:00.000Z',
              amount_minor: 399,
              currency: 'USD'
            }
          }
        }
      }
    ];

    const [candidate] = derivePurchaseCandidates(items, null);

    expect(candidate).toMatchObject({
      source_record_id: 'records:line',
      source_module: 'shopping',
      label: 'Napkins',
      amount_minor: 399,
      currency: 'USD'
    });
  });

  it('hides purchase-only shopping candidates once posted money references them', () => {
    const items: Item[] = [
      {
        id: 'records:line',
        text: 'Napkins',
        module_settings: {
          shopping_module: {
            line_item: {
              status: 'purchased',
              label: 'Napkins',
              purchase_mode: 'purchase_only',
              purchased_at: '2026-04-22T00:00:00.000Z'
            }
          }
        }
      },
      {
        id: 'records:money',
        text: 'Napkins',
        additionals: [
          {
            id: 'tx',
            type: 'transaction',
            currency: 'USD',
            amount_minor: 399,
            debit_credit: 'debit'
          } as any
        ],
        module_settings: {
          money_module: {
            financial_transaction: {
              account_id: 'records:cash',
              currency: 'USD',
              amount_minor: 399,
              debit_credit: 'debit',
              posted_at: '2026-04-22T00:05:00.000Z',
              status: 'posted',
              source_record_id: 'records:line',
              source_module: 'shopping'
            }
          }
        }
      }
    ];

    expect(derivePurchaseCandidates(items, null)).toEqual([]);
  });
});

describe('money posting helpers', () => {
  it('adds, replaces, and removes posting transaction additionals', () => {
    const posted = postedAdditionalsForFinancialTransaction([], {
      currency: 'usd',
      amount_minor: 1299,
      debit_credit: 'debit'
    });

    expect(posted).toEqual([
      expect.objectContaining({
        type: 'transaction',
        currency: 'USD',
        amount_minor: 1299,
        debit_credit: 'debit'
      })
    ]);

    const replaced = postedAdditionalsForFinancialTransaction(posted, {
      currency: 'USD',
      amount_minor: 1500,
      debit_credit: 'credit'
    });

    expect(replaced).toHaveLength(1);
    expect(replaced[0]).toMatchObject({
      id: posted[0]?.id,
      type: 'transaction',
      amount_minor: 1500,
      debit_credit: 'credit'
    });

    expect(unpostedAdditionalsForFinancialTransaction(replaced)).toEqual([]);
  });

  it('builds transaction additionals in the server balance shape', () => {
    expect(buildTransactionAdditional({
      currency: 'aud',
      amount_minor: 500,
      debit_credit: 'credit',
      id: 'tx-fixed'
    })).toEqual({
      id: 'tx-fixed',
      type: 'transaction',
      currency: 'AUD',
      amount_minor: 500,
      debit_credit: 'credit'
    });
  });
});

describe('money ⇄ server balance-propagation contract', () => {
  it('emits transaction additionals the server rollup accepts', () => {
    expect(serverAcceptsTransactionAdditional(
      buildTransactionAdditional({ currency: 'usd', amount_minor: 1234, debit_credit: 'debit' })
    )).toBe(true);
    expect(serverAcceptsTransactionAdditional(
      buildTransactionAdditional({ currency: 'eur', amount_minor: 0, debit_credit: 'credit' })
    )).toBe(true);
  });

  it('emits the posted-transaction additional in an accepted shape', () => {
    const additionals = postedAdditionalsForFinancialTransaction([], {
      currency: 'GBP',
      amount_minor: 4200,
      debit_credit: 'debit'
    });
    const tx = additionals.find((a) => (a as any).type === 'transaction');
    expect(tx).toBeDefined();
    expect(serverAcceptsTransactionAdditional(tx)).toBe(true);
  });

  it('emits an account_balance MARKER the server accepts (value stays server-owned)', () => {
    const marker = buildAccountBalanceAdditional({ currency: 'usd' });
    expect(serverAcceptsAccountBalanceAdditional(marker)).toBe(true);
    expect((marker as any).mode).toBe('rollup');
    expect((marker as any).currency).toBe('USD');
    expect((marker as any).computed).toBeUndefined();
    expect((marker as any).balance_minor).toBeUndefined();
  });

  it('rejects malformed transaction additionals (guards against silent rollup breakage)', () => {
    // Negative amount, blank currency, and an unknown debit/credit must all be
    // rejected — these mirror the cases the server predicate filters out.
    expect(serverAcceptsTransactionAdditional({ type: 'transaction', currency: 'USD', amount_minor: -1, debit_credit: 'debit' })).toBe(false);
    expect(serverAcceptsTransactionAdditional({ type: 'transaction', currency: '', amount_minor: 100, debit_credit: 'credit' })).toBe(false);
    expect(serverAcceptsTransactionAdditional({ type: 'transaction', currency: 'USD', amount_minor: 100, debit_credit: 'refund' })).toBe(false);
    expect(serverAcceptsTransactionAdditional({ type: 'account_balance', currency: 'USD', amount_minor: 100, debit_credit: 'debit' })).toBe(false);
  });

  it('rejects a non-computed account_balance (server only rolls up computed:true)', () => {
    expect(serverAcceptsAccountBalanceAdditional({ type: 'account_balance', currency: 'USD', balance_minor: 5, computed: true })).toBe(false);
    expect(serverAcceptsAccountBalanceAdditional({ type: 'account_balance', currency: '', mode: 'rollup' })).toBe(false);
  });
});

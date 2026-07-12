import { describe, expect, it } from 'vitest';
import type { AdditionalWithId } from './types.ts';
import {
  additionalValidators,
  validateAdditionalEnvelope,
  validateAdditionals
} from './additional-validate.ts';

const VALID_ID = '019f1234-5678-4abc-9def-0123456789ab';

describe('validateAdditionalEnvelope', () => {
  it('accepts a well-formed envelope', () => {
    expect(validateAdditionalEnvelope({ id: VALID_ID, type: 'transaction' })).toBeNull();
  });
  it('rejects a non-uuid id', () => {
    expect(validateAdditionalEnvelope({ id: 'temp:abc', type: 'transaction' })).toBe(
      'invalid_additional_id'
    );
  });
  it('rejects a missing/empty type', () => {
    expect(validateAdditionalEnvelope({ id: VALID_ID, type: '' })).toBe('invalid_additional_envelope');
    expect(validateAdditionalEnvelope({ id: VALID_ID })).toBe('invalid_additional_envelope');
  });
});

describe('transaction validator', () => {
  const v = additionalValidators.transaction;
  it('accepts a valid transaction', () => {
    expect(v({ currency: 'usd', amount_minor: 1250, debit_credit: 'debit' })).toBeNull();
  });
  it('uppercases currency before checking', () => {
    expect(v({ currency: 'eur', amount_minor: 0, debit_credit: 'credit' })).toBeNull();
  });
  it('rejects an empty currency', () => {
    expect(v({ currency: '', amount_minor: 1250, debit_credit: 'debit' })).toBe(
      'invalid_transaction_additional'
    );
  });
  it('rejects a negative amount', () => {
    expect(v({ currency: 'usd', amount_minor: -1, debit_credit: 'debit' })).toBe(
      'invalid_transaction_additional'
    );
  });
  it('rejects an unknown direction', () => {
    expect(v({ currency: 'usd', amount_minor: 1250, debit_credit: 'transfer' })).toBe(
      'invalid_transaction_additional'
    );
  });
});

describe('account_balance validator', () => {
  const v = additionalValidators.account_balance;
  it('accepts a rollup marker with a currency and no balance_minor', () => {
    expect(v({ mode: 'rollup', currency: 'usd' })).toBeNull();
  });
  it('rejects a non-marker (manual balance would be server-owned)', () => {
    expect(v({ currency: 'usd', balance_minor: 100 })).toBe('invalid_account_balance_additional');
  });
  it('rejects a marker missing a currency', () => {
    expect(v({ mode: 'rollup' })).toBe('invalid_account_balance_additional');
  });
});

describe('validateAdditionals', () => {
  it('returns null for an empty/null list', () => {
    expect(validateAdditionals(null)).toBeNull();
    expect(validateAdditionals([])).toBeNull();
  });
  it('returns the first reject reason for a bad transaction', () => {
    const bad = { id: VALID_ID, type: 'transaction', currency: '', amount_minor: 5, debit_credit: 'debit' } as AdditionalWithId;
    expect(validateAdditionals([bad])).toBe('invalid_transaction_additional');
  });
  it('skips computed entries (server-owned, stripped at ingress)', () => {
    const computed = { id: VALID_ID, type: 'pg', computed: true } as unknown as AdditionalWithId;
    expect(validateAdditionals([computed])).toBeNull();
  });
  it('passes a clean list', () => {
    const ok = { id: VALID_ID, type: 'transaction', currency: 'usd', amount_minor: 0, debit_credit: 'credit' } as AdditionalWithId;
    expect(validateAdditionals([ok])).toBeNull();
  });
});
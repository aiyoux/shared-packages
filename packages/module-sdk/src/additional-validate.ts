import type { AdditionalWithId } from './types.ts';

/**
 * Client mirror of the server validation chokepoint (fn::validate_additionals
 * in surql/runtime/standard_functions/additional_validation.surql). Catching
 * an invalid entry BEFORE it is queued turns a silent server-side op
 * rejection (which wedges the item's sync status) into an immediate,
 * debuggable error at the call site.
 *
 * Adding a validated type = one entry here + one fn::validate_additional_<type>
 * server-side. Reason strings match the server's sync_ops reject_reason values.
 */

type Validator = (additional: Record<string, unknown>) => string | null;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function validateAdditionalEnvelope(additional: unknown): string | null {
  if (!additional || typeof additional !== 'object') return 'invalid_additional_envelope';
  const raw = additional as Record<string, unknown>;
  if (typeof raw.id !== 'string' || !UUID_RE.test(raw.id)) return 'invalid_additional_id';
  if (typeof raw.type !== 'string' || raw.type === '') return 'invalid_additional_envelope';
  if (raw.updated_at != null && typeof raw.updated_at !== 'string') return 'invalid_additional_envelope';
  return null;
}

export const additionalValidators: Record<string, Validator> = {
  transaction: (raw) => {
    const currency = String(raw.currency ?? '').toUpperCase();
    const amountMinor = Number(raw.amount_minor ?? -1);
    const dc = String(raw.debit_credit ?? '').toLowerCase();
    const valid = currency !== ''
      && Number.isFinite(amountMinor) && amountMinor >= 0
      && (dc === 'debit' || dc === 'credit');
    return valid ? null : 'invalid_transaction_additional';
  },
  account_balance: (raw) => {
    // Authored entries must be account MARKERS — the balance VALUE is
    // server-owned (computed entries never reach the wire; see
    // applyAdditionalsMutation / normalizeAdditionalsForSurreal).
    const currency = String(raw.currency ?? '').toUpperCase();
    const valid = raw.mode === 'rollup' && currency !== '' && raw.balance_minor === undefined;
    return valid ? null : 'invalid_account_balance_additional';
  }
};

/** First reject reason for the list, or null when everything is acceptable. */
export function validateAdditionals(additionals: AdditionalWithId[] | null | undefined): string | null {
  for (const entry of additionals ?? []) {
    const raw = entry as unknown as Record<string, unknown>;
    // Server-computed entries are stripped at ingress, never rejected — skip.
    if (raw.computed === true) continue;
    const envelope = validateAdditionalEnvelope(raw);
    if (envelope) return envelope;
    const validator = additionalValidators[String(raw.type)];
    const reason = validator ? validator(raw) : null;
    if (reason) return reason;
  }
  return null;
}

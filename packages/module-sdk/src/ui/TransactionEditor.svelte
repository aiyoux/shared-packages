<script lang="ts">
  // Structured editor for the `transaction` additional.
  //
  // Shape: `{ id, type:'transaction', currency, amount_minor, debit_credit,
  //   transfer_id?, counterparty_tx_id? }`. Fields live directly on the
  // additional, so this editor takes the whole additional and emits the next
  // whole additional via `onChange`.
  //
  // DRY: the core rebuild goes through the SDK `buildTransactionAdditional`
  // (currency normalization + non-negative integer clamping/rounding), and the
  // draft is checked against the client mirror of the server validator
  // (`validateAdditionals`) so an invalid entry is surfaced immediately rather
  // than wedging sync status on a silent server-side op rejection.

  import type { AdditionalWithId } from '../types.ts';
  import { validateAdditionals } from '../additional-validate.ts';
  import { buildTransactionAdditional, type DebitCredit } from '../scheduler/money.ts';
  import { Label, NumberInput, SegmentedControl, type SegmentedControlOption } from '@modular-app/ui';

  let {
    additional,
    onChange
  }: {
    additional: AdditionalWithId | Record<string, any>;
    onChange?: (next: AdditionalWithId | Record<string, any>) => void;
  } = $props();

  const DC_OPTIONS: SegmentedControlOption<DebitCredit>[] = [
    { value: 'debit', label: 'Debit' },
    { value: 'credit', label: 'Credit' }
  ];

  const currencyStr = $derived(String((additional as any).currency ?? ''));
  const amountStr = $derived(String((additional as any).amount_minor ?? ''));
  const dcValue = $derived(
    (additional as any).debit_credit === 'credit' ? 'credit' : 'debit'
  );
  const transferId = $derived(String((additional as any).transfer_id ?? ''));
  const counterpartyTxId = $derived(String((additional as any).counterparty_tx_id ?? ''));

  function rebuild(patch: {
    currency?: string;
    amount_minor?: number;
    debit_credit?: DebitCredit;
    transfer_id?: string | null;
    counterparty_tx_id?: string | null;
  }): AdditionalWithId {
    const a = additional as any;
    const next = buildTransactionAdditional({
      id: a.id,
      currency: patch.currency !== undefined ? patch.currency : a.currency ?? 'USD',
      amount_minor:
        patch.amount_minor !== undefined ? patch.amount_minor : Number(a.amount_minor ?? 0),
      debit_credit: patch.debit_credit !== undefined ? patch.debit_credit : (dcValue as DebitCredit)
    });
    const transfer = patch.transfer_id !== undefined ? patch.transfer_id : a.transfer_id ?? null;
    const counterparty =
      patch.counterparty_tx_id !== undefined ? patch.counterparty_tx_id : a.counterparty_tx_id ?? null;
    return {
      ...next,
      ...(transfer ? { transfer_id: transfer } : {}),
      ...(counterparty ? { counterparty_tx_id: counterparty } : {})
    } as AdditionalWithId;
  }

  // Current draft validity (client mirror of fn::validate_additional_transaction).
  const validationError = $derived(validateAdditionals([additional as AdditionalWithId]));

  function emit(next: AdditionalWithId | Record<string, any>) {
    onChange?.(next);
  }
  function onCurrency(raw: string) {
    emit(rebuild({ currency: raw.trim().toUpperCase() }));
  }
  function onAmount(raw: string) {
    const n = Number(raw);
    emit(rebuild({ amount_minor: Number.isFinite(n) ? Math.max(0, Math.round(n)) : 0 }));
  }
  function onDebitCredit(v: string | number | null) {
    emit(rebuild({ debit_credit: (v === 'credit' ? 'credit' : 'debit') as DebitCredit }));
  }
  function onTransferId(raw: string) {
    emit(rebuild({ transfer_id: raw.trim() || null }));
  }
  function onCounterparty(raw: string) {
    emit(rebuild({ counterparty_tx_id: raw.trim() || null }));
  }
</script>

<div class="flex flex-col gap-3">
  <div class="flex items-center gap-2" class:opacity-50={!currencyStr}>
    <div class="flex flex-col gap-1.5 flex-1">
      <Label class="text-[var(--text-xs)] font-semibold">Currency</Label>
      <input
        type="text"
        value={currencyStr}
        placeholder="USD"
        maxlength={3}
        oninput={(e) => onCurrency((e.currentTarget as HTMLInputElement).value)}
        class="w-24 uppercase rounded-[var(--radius-md)] border border-[var(--color-border)] bg-[var(--color-input)] px-3 py-2 text-[var(--text-sm)] text-[var(--color-foreground)] placeholder:text-[var(--color-muted-foreground)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-primary)]"
      />
    </div>
    <div class="flex flex-col gap-1.5 flex-1">
      <Label class="text-[var(--text-xs)] font-semibold">Amount (minor units)</Label>
      <NumberInput value={amountStr} onchange={onAmount} min={0} placeholder="0" class="w-36" />
      <p class="text-[var(--text-xs)] text-[var(--color-muted-foreground)]">
        Integer minor units (e.g. 1250 = $12.50).
      </p>
    </div>
  </div>

  <div class="flex flex-col gap-1.5">
    <Label class="text-[var(--text-xs)] font-semibold">Direction</Label>
    <SegmentedControl
      value={dcValue}
      options={DC_OPTIONS}
      fullWidth
      ariaLabel="Debit or credit"
      onValueChange={onDebitCredit}
    />
  </div>

  <div class="flex flex-col gap-1.5">
    <Label class="text-[var(--text-xs)] font-semibold">Transfer id (optional)</Label>
    <input
      type="text"
      value={transferId}
      placeholder="records:…"
      oninput={(e) => onTransferId((e.currentTarget as HTMLInputElement).value)}
      class="w-full rounded-[var(--radius-md)] border border-[var(--color-border)] bg-[var(--color-input)] px-3 py-2 text-[var(--text-sm)] text-[var(--color-foreground)] placeholder:text-[var(--color-muted-foreground)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-primary)]"
    />
  </div>

  <div class="flex flex-col gap-1.5">
    <Label class="text-[var(--text-xs)] font-semibold">Counterparty tx id (optional)</Label>
    <input
      type="text"
      value={counterpartyTxId}
      placeholder="records:…"
      oninput={(e) => onCounterparty((e.currentTarget as HTMLInputElement).value)}
      class="w-full rounded-[var(--radius-md)] border border-[var(--color-border)] bg-[var(--color-input)] px-3 py-2 text-[var(--text-sm)] text-[var(--color-foreground)] placeholder:text-[var(--color-muted-foreground)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-primary)]"
    />
  </div>

  {#if validationError}
    <div class="rounded-[var(--radius-sm)] border border-amber-300 bg-amber-50 px-3 py-2 text-[var(--text-xs)] text-amber-800">
      Invalid transaction: {validationError}. Fix before saving or this entry will be rejected on sync.
    </div>
  {/if}
</div>
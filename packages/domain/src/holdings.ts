import { indexState, validateTransactionReferences } from "./calculate.js";
import { dayIndex } from "./calendar.js";
import { convertMinor, safeMinorOrNull } from "./currency.js";
import { debtMetricsOf } from "./debts.js";
import type { AccountId, BudgetState, DebtMetrics, HoldingsMetrics, LocalDate, MinorUnits } from "./types.js";

/*
 * ─────────────────────────── Holdings ───────────────────────────
 *
 * What the family has, as opposed to what its month did. `BudgetMetrics` counts the operations of
 * a budget's window, so its account balances start again with every month and a July purchase is
 * not in August's figures. Holdings count from the day each account was opened, and value what is
 * held in another currency at the rate of the day asked about — the one place a balance is
 * converted rather than an operation's own snapshot read (plan 2, D-031).
 *
 * `capitalMinor` keeps its meaning; which of the two figures a screen calls «капитал» is the
 * owner's question (plan, open questions).
 */

/** A sum that stays a safe integer, or null when it would not. */
function addOrNull(total: MinorUnits, value: MinorUnits): MinorUnits | null {
  const sum = total + value;
  return Number.isSafeInteger(sum) ? sum : null;
}

export interface HoldingsOptions {
  /**
   * `calculateDebts(state, asOf)` of this very state, when the caller has already computed it: the
   * holdings then reuse it instead of valuing every debt a second time. Ignored unless it is of the
   * same day and the same base currency.
   */
  readonly debts?: DebtMetrics;
}

/**
 * Every account and every debt of the household on `asOf`, in its own currency and in the base
 * one, and what it all comes to.
 *
 * An account's balance is its opening balance plus every posted operation dated on or before
 * `asOf`; a transfer between currencies credits what arrived. Archived accounts count — archiving
 * closes an account for new operations, it does not spend what is on it — and so do accounts left
 * out of the total (`includeInTotal: false`), which have their values but do not add to the total.
 *
 * Never throws on a magnitude, exactly as {@link calculateDebts} does not: balances are summed
 * exactly, and a balance outside the safe range, a missing rate or a value too large to represent
 * gives null and a listed account, and the total carries what could be valued. It does throw, like
 * every calculation, on a state the domain refuses.
 */
export function calculateHoldings(state: BudgetState, asOf: LocalDate, options: HoldingsOptions = {}): HoldingsMetrics {
  const index = indexState(state);
  dayIndex(asOf, "asOf");
  for (const transaction of state.transactions) validateTransactionReferences(transaction, index);
  const baseCurrency = index.baseCurrency;

  const balances = new Map<AccountId, bigint>(state.accounts.map((account) => [account.id, BigInt(account.openingBalanceMinor)]));
  const change = (accountId: AccountId, amount: MinorUnits): void => {
    balances.set(accountId, (balances.get(accountId) ?? 0n) + BigInt(amount));
  };
  for (const transaction of state.transactions) {
    if (transaction.status !== "posted" || transaction.occurredOn > asOf) continue;
    switch (transaction.kind) {
      case "income":
      case "refund":
      case "debt_in":
        change(transaction.accountId, transaction.amountMinor);
        break;
      case "expense":
      case "debt_out":
        change(transaction.accountId, -transaction.amountMinor);
        break;
      case "transfer":
        change(transaction.fromAccountId, -transaction.amountMinor);
        change(transaction.toAccountId, transaction.toAmountMinor ?? transaction.amountMinor);
        break;
      case "goal_contribution":
        change(transaction.fromAccountId, -transaction.amountMinor);
        change(transaction.toAccountId, transaction.amountMinor);
        break;
    }
  }

  const accountBalancesMinor = Object.create(null) as Record<AccountId, MinorUnits | null>;
  const accountBalancesInBaseMinor = Object.create(null) as Record<AccountId, MinorUnits | null>;
  const unvaluedAccountIds: AccountId[] = [];
  let totalInBaseMinor = 0;

  for (const account of state.accounts) {
    const balance = safeMinorOrNull(balances.get(account.id) ?? 0n);
    let inBase: MinorUnits | null = null;
    if (balance !== null && account.currency === baseCurrency) {
      inBase = balance;
    } else if (balance !== null) {
      const rate = index.rates.find(account.currency, baseCurrency, asOf);
      if (rate !== undefined) {
        try {
          inBase = convertMinor(balance, rate.rate);
        } catch {
          inBase = null;
        }
      }
    }
    if (inBase !== null && account.includeInTotal !== false) {
      const next = addOrNull(totalInBaseMinor, inBase);
      // An account that would carry the total past what can be represented is not valued either:
      // a total that silently left it out would be a figure nobody could check.
      if (next === null) inBase = null;
      else totalInBaseMinor = next;
    }
    if (inBase === null) unvaluedAccountIds.push(account.id);
    accountBalancesMinor[account.id] = balance;
    accountBalancesInBaseMinor[account.id] = inBase;
  }

  const given = options.debts;
  const debts = given !== undefined && given.asOf === asOf && given.baseCurrency === baseCurrency
    ? given
    : debtMetricsOf(state, index, asOf);
  // Exactly, in BigInt: a total and a receivable each within the safe range may still not add up
  // within it, and a float sum that lost a digit on the way would come back looking safe.
  const netWorth = safeMinorOrNull(BigInt(totalInBaseMinor) + BigInt(debts.receivableInBaseMinor) - BigInt(debts.payableInBaseMinor));
  return {
    asOf,
    baseCurrency,
    accountBalancesMinor,
    accountBalancesInBaseMinor,
    totalInBaseMinor,
    unvaluedAccountIds,
    debts,
    netWorthInBaseMinor: netWorth,
  };
}

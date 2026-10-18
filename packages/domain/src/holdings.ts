import { indexState, validateTransactionReferences } from "./calculate.js";
import { dayIndex } from "./calendar.js";
import { convertMinor, findRate } from "./currency.js";
import { calculateDebts } from "./debts.js";
import type { AccountId, BudgetState, HoldingsMetrics, LocalDate, MinorUnits } from "./types.js";

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
function addOrNull(total: MinorUnits | null, value: MinorUnits): MinorUnits | null {
  if (total === null) return null;
  const sum = total + value;
  return Number.isSafeInteger(sum) ? sum : null;
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
 * Never throws for a missing rate or a sum too large to represent: such an account is valued at
 * null and listed in `unvaluedAccountIds`, and the total carries what could be valued, exactly as
 * {@link calculateDebts} does for a debt. It does throw, like every calculation, on a state the
 * domain refuses.
 */
export function calculateHoldings(state: BudgetState, asOf: LocalDate): HoldingsMetrics {
  const index = indexState(state);
  dayIndex(asOf, "asOf");
  for (const transaction of state.transactions) validateTransactionReferences(transaction, index);
  const baseCurrency = index.baseCurrency;
  const rates = [...index.exchangeRates.values()];

  const balances = new Map<AccountId, MinorUnits | null>(state.accounts.map((account) => [account.id, account.openingBalanceMinor]));
  const change = (accountId: AccountId, amount: MinorUnits): void => {
    balances.set(accountId, addOrNull(balances.get(accountId) ?? null, amount));
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
    const balance = balances.get(account.id) ?? null;
    let inBase: MinorUnits | null = null;
    if (balance !== null) {
      if (account.currency === baseCurrency) {
        inBase = balance;
      } else {
        const rate = findRate(rates, account.currency, baseCurrency, asOf);
        if (rate !== undefined) {
          try {
            inBase = convertMinor(balance, rate.rate);
          } catch {
            inBase = null;
          }
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

  const debts = calculateDebts(state, asOf);
  // Exactly, in BigInt: a total and a receivable each within the safe range may still not add up
  // within it, and a float sum that lost a digit on the way would come back looking safe.
  const exact = BigInt(totalInBaseMinor) + BigInt(debts.receivableInBaseMinor) - BigInt(debts.payableInBaseMinor);
  const netWorth = Number(exact);
  return {
    asOf,
    baseCurrency,
    accountBalancesMinor,
    accountBalancesInBaseMinor,
    totalInBaseMinor,
    unvaluedAccountIds,
    debts,
    netWorthInBaseMinor: Number.isSafeInteger(netWorth) && BigInt(netWorth) === exact ? netWorth : null,
  };
}

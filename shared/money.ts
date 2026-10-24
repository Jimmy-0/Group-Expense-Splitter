// Pure money logic. Every amount is an integer number of cents; floats never touch money.

import type { Balance, ExpenseShare, Transfer } from "./types.ts";

export class MoneyError extends Error {}

/** Largest single amount accepted: $10,000,000.00. Keeps every product below 2^53. */
export const MAX_CENTS = 1_000_000_000;
export const FULL_PERCENT_BP = 10_000; // 100.00% in basis points

const AMOUNT_RE = /^(\d{1,8})(?:\.(\d{1,2}))?$/;
const PERCENT_RE = /^(\d{1,3})(?:\.(\d{1,2}))?$/;

/** "12.5" -> 1250. Rejects negatives, >2 decimals, exponents, and anything non-decimal. */
export function parseCents(raw: string, field = "amount"): number {
  const m = AMOUNT_RE.exec(raw.trim());
  if (!m) throw new MoneyError(`${field} must be a positive decimal with at most 2 decimal places, got "${raw}"`);
  const cents = Number(m[1]) * 100 + Number((m[2] ?? "").padEnd(2, "0"));
  if (cents > MAX_CENTS) throw new MoneyError(`${field} exceeds the maximum of ${formatCents(MAX_CENTS)}`);
  return cents;
}

/** "33.33" -> 3333 basis points. */
export function parseBasisPoints(raw: string, field = "percent"): number {
  const m = PERCENT_RE.exec(raw.trim());
  if (!m) throw new MoneyError(`${field} must be a decimal with at most 2 decimal places, got "${raw}"`);
  const bp = Number(m[1]) * 100 + Number((m[2] ?? "").padEnd(2, "0"));
  if (bp > FULL_PERCENT_BP) throw new MoneyError(`${field} cannot exceed 100%`);
  return bp;
}

/** 1250 -> "12.50": the inverse of parseCents, used to pre-fill inputs. */
export function centsToDecimal(cents: number): string {
  return `${Math.floor(cents / 100)}.${String(cents % 100).padStart(2, "0")}`;
}

export function formatCents(cents: number): string {
  const sign = cents < 0 ? "-" : "";
  const abs = Math.abs(cents);
  return `${sign}$${Math.floor(abs / 100).toLocaleString("en-US")}.${String(abs % 100).padStart(2, "0")}`;
}

/**
 * Split `total` cents proportionally to integer `weights` (largest remainder method).
 * Result always sums to exactly `total`. Leftover cents go to the largest fractional
 * remainders; ties go to the earlier index, so results are deterministic.
 */
export function allocate(total: number, weights: number[]): number[] {
  const weightSum = weights.reduce((a, b) => a + b, 0);
  if (weightSum <= 0) throw new MoneyError("cannot allocate across zero total weight");
  const base = weights.map((w) => Math.floor((total * w) / weightSum));
  const remainders = weights.map((w, i) => ({ i, r: (total * w) % weightSum }));
  let leftover = total - base.reduce((a, b) => a + b, 0);
  remainders.sort((a, b) => b.r - a.r || a.i - b.i);
  for (const { i } of remainders) {
    if (leftover === 0) break;
    base[i]! += 1;
    leftover -= 1;
  }
  return base;
}

export type SplitInput =
  | { mode: "equal"; memberIds: number[] }
  | { mode: "exact"; shares: { memberId: number; amount: string }[] }
  | { mode: "percent"; shares: { memberId: number; percent: string }[] };

function assertUniqueMembers(ids: number[]): void {
  if (ids.length === 0) throw new MoneyError("split must include at least one member");
  if (new Set(ids).size !== ids.length) throw new MoneyError("split lists the same member more than once");
}

/** Turn a user split description into per-member cents that sum exactly to `totalCents`. */
export function resolveSplit(totalCents: number, split: SplitInput): ExpenseShare[] {
  switch (split.mode) {
    case "equal": {
      assertUniqueMembers(split.memberIds);
      const amounts = allocate(totalCents, split.memberIds.map(() => 1));
      return split.memberIds.map((memberId, i) => ({ memberId, input: null, amountCents: amounts[i]! }));
    }
    case "exact": {
      assertUniqueMembers(split.shares.map((s) => s.memberId));
      const shares = split.shares.map((s) => {
        const cents = s.amount.trim() === "" ? 0 : parseCents(s.amount, "share amount");
        return { memberId: s.memberId, input: cents, amountCents: cents };
      });
      const sum = shares.reduce((a, s) => a + s.amountCents, 0);
      if (sum !== totalCents) {
        throw new MoneyError(
          `exact shares add up to ${formatCents(sum)} but the expense is ${formatCents(totalCents)} (off by ${formatCents(totalCents - sum)})`,
        );
      }
      return shares;
    }
    case "percent": {
      assertUniqueMembers(split.shares.map((s) => s.memberId));
      const bps = split.shares.map((s) => (s.percent.trim() === "" ? 0 : parseBasisPoints(s.percent)));
      const sum = bps.reduce((a, b) => a + b, 0);
      if (sum !== FULL_PERCENT_BP) {
        throw new MoneyError(`percentages add up to ${(sum / 100).toFixed(2)}%, they must add up to exactly 100%`);
      }
      const amounts = allocate(totalCents, bps);
      return split.shares.map((s, i) => ({ memberId: s.memberId, input: bps[i]!, amountCents: amounts[i]! }));
    }
  }
}

export interface LedgerEntry {
  paidBy: number;
  amountCents: number;
  shares: { memberId: number; amountCents: number }[];
}

/** Net position per member. Output order follows `memberIds`; nets always sum to 0. */
export function computeBalances(memberIds: number[], entries: LedgerEntry[]): Balance[] {
  const map = new Map<number, Balance>();
  const get = (id: number) => {
    let b = map.get(id);
    if (!b) map.set(id, (b = { memberId: id, paidCents: 0, owedCents: 0, netCents: 0 }));
    return b;
  };
  memberIds.forEach(get);
  for (const e of entries) {
    get(e.paidBy).paidCents += e.amountCents;
    for (const s of e.shares) get(s.memberId).owedCents += s.amountCents;
  }
  for (const b of map.values()) b.netCents = b.paidCents - b.owedCents;
  return [...map.values()];
}

/** Above this many non-zero balances, fall back to greedy (still <= n-1 transfers). */
export const EXACT_SETTLE_LIMIT = 18;

/**
 * Minimum-transfer settlement.
 *
 * With k people holding non-zero balances, the optimum is k - p transfers, where p is the
 * maximum number of disjoint zero-sum groups the people can be partitioned into (each
 * group of size m settles internally with m-1 transfers). We find p with a bitmask DP
 * (O(2^k * k)), then settle each group greedily. Finding the true minimum is NP-hard,
 * so beyond EXACT_SETTLE_LIMIT people we settle everyone greedily.
 */
export function settleUp(balances: Pick<Balance, "memberId" | "netCents">[]): Transfer[] {
  const people = balances.filter((b) => b.netCents !== 0);
  const total = people.reduce((a, b) => a + b.netCents, 0);
  if (total !== 0) throw new Error(`balances must sum to zero, got ${total}`);
  if (people.length === 0) return [];
  if (people.length > EXACT_SETTLE_LIMIT) return greedySettle(people);

  const k = people.length;
  const full = (1 << k) - 1;
  const sum = new Float64Array(1 << k);
  const dp = new Int8Array(1 << k);
  for (let mask = 1; mask <= full; mask++) {
    const low = 31 - Math.clz32(mask & -mask);
    sum[mask] = sum[mask & (mask - 1)]! + people[low]!.netCents;
    let best = 0;
    for (let i = 0; i < k; i++) if (mask & (1 << i)) best = Math.max(best, dp[mask ^ (1 << i)]!);
    dp[mask] = best + (sum[mask] === 0 ? 1 : 0);
  }

  // Walk back from the full set along a chain of optimal predecessors. Zero-sum masks on
  // that chain cut the people into consecutive groups that each sum to zero.
  const groups: (typeof people)[] = [];
  let mask = full;
  let groupMask = full;
  while (mask) {
    const target = dp[mask]! - (sum[mask] === 0 ? 1 : 0);
    let next = -1;
    for (let i = 0; i < k; i++) {
      if (mask & (1 << i) && dp[mask ^ (1 << i)] === target) {
        next = mask ^ (1 << i);
        break;
      }
    }
    mask = next;
    if (sum[mask] === 0) {
      const g = groupMask ^ mask;
      groups.push(people.filter((_, i) => g & (1 << i)));
      groupMask = mask;
    }
  }
  return groups.flatMap(greedySettle);
}

/** Repeatedly pay the largest debtor to the largest creditor. Each step zeroes at least one person. */
function greedySettle(people: Pick<Balance, "memberId" | "netCents">[]): Transfer[] {
  const order = (a: { memberId: number; amt: number }, b: { memberId: number; amt: number }) =>
    b.amt - a.amt || a.memberId - b.memberId;
  const creditors = people.filter((p) => p.netCents > 0).map((p) => ({ memberId: p.memberId, amt: p.netCents }));
  const debtors = people.filter((p) => p.netCents < 0).map((p) => ({ memberId: p.memberId, amt: -p.netCents }));
  const out: Transfer[] = [];
  while (creditors.length && debtors.length) {
    creditors.sort(order);
    debtors.sort(order);
    const c = creditors[0]!;
    const d = debtors[0]!;
    const amt = Math.min(c.amt, d.amt);
    out.push({ from: d.memberId, to: c.memberId, amountCents: amt });
    c.amt -= amt;
    d.amt -= amt;
    if (c.amt === 0) creditors.shift();
    if (d.amt === 0) debtors.shift();
  }
  return out;
}

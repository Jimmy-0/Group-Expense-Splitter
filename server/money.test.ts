import { describe, expect, it } from "vitest";
import {
  allocate,
  computeBalances,
  EXACT_SETTLE_LIMIT,
  MoneyError,
  parseBasisPoints,
  parseCents,
  resolveSplit,
  settleUp,
} from "../shared/money.ts";
import type { Transfer } from "../shared/types.ts";

describe("parseCents", () => {
  it.each([
    ["100", 10000],
    ["100.5", 10050],
    ["0.01", 1],
    ["33.33", 3333],
    [" 7.10 ", 710],
  ])("parses %j", (raw, cents) => expect(parseCents(raw)).toBe(cents));

  it.each(["", "-5", "1.234", "1e3", "abc", "1,000", ".5", "NaN", "100000000"])("rejects %j", (raw) =>
    expect(() => parseCents(raw)).toThrow(MoneyError),
  );
});

describe("parseBasisPoints", () => {
  it("parses decimals", () => expect(parseBasisPoints("33.33")).toBe(3333));
  it("rejects over 100%", () => expect(() => parseBasisPoints("100.01")).toThrow(MoneyError));
  it("rejects 3 decimals", () => expect(() => parseBasisPoints("33.333")).toThrow(MoneyError));
});

describe("allocate", () => {
  it("$100 three ways sums to exactly $100", () => {
    expect(allocate(10000, [1, 1, 1])).toEqual([3334, 3333, 3333]);
  });

  it("gives leftover cents to largest remainders, not just the first index", () => {
    // 1 cent at weights 1:2 -> exact 0.333 / 0.667, the bigger fraction wins.
    expect(allocate(1, [1, 2])).toEqual([0, 1]);
  });

  it("always sums to the total for many random inputs", () => {
    let seed = 42;
    const rand = (n: number) => (seed = (seed * 1103515245 + 12345) % 2 ** 31) % n;
    for (let t = 0; t < 2000; t++) {
      const total = rand(1_000_000) + 1;
      const weights = Array.from({ length: rand(9) + 1 }, () => rand(5000));
      if (!weights.some((w) => w > 0)) weights[0] = 1;
      const out = allocate(total, weights);
      expect(out.reduce((a, b) => a + b, 0)).toBe(total);
      const ws = weights.reduce((a, b) => a + b, 0);
      out.forEach((v, i) => expect(Math.abs(v - (total * weights[i]!) / ws)).toBeLessThan(1));
    }
  });
});

describe("resolveSplit", () => {
  it("equal: $0.01 among 3 people", () => {
    expect(resolveSplit(1, { mode: "equal", memberIds: [1, 2, 3] }).map((s) => s.amountCents)).toEqual([1, 0, 0]);
  });

  it("exact: must sum to the total", () => {
    expect(() =>
      resolveSplit(10000, {
        mode: "exact",
        shares: [
          { memberId: 1, amount: "33.33" },
          { memberId: 2, amount: "33.33" },
          { memberId: 3, amount: "33.33" },
        ],
      }),
    ).toThrow(/off by \$0\.01/);
    const ok = resolveSplit(10000, {
      mode: "exact",
      shares: [
        { memberId: 1, amount: "50" },
        { memberId: 2, amount: "49.99" },
        { memberId: 3, amount: "0.01" },
      ],
    });
    expect(ok.map((s) => s.amountCents)).toEqual([5000, 4999, 1]);
  });

  it("percent: 33.33/33.33/33.34 of $100", () => {
    const out = resolveSplit(10000, {
      mode: "percent",
      shares: [
        { memberId: 1, percent: "33.33" },
        { memberId: 2, percent: "33.33" },
        { memberId: 3, percent: "33.34" },
      ],
    });
    expect(out.map((s) => s.amountCents)).toEqual([3333, 3333, 3334]);
    expect(out.map((s) => s.input)).toEqual([3333, 3333, 3334]);
  });

  it("percent: rounding of an odd total still sums exactly", () => {
    const out = resolveSplit(1001, {
      mode: "percent",
      shares: [
        { memberId: 1, percent: "50" },
        { memberId: 2, percent: "50" },
      ],
    });
    expect(out.map((s) => s.amountCents)).toEqual([501, 500]);
  });

  it("percent: must total 100%", () => {
    expect(() =>
      resolveSplit(100, {
        mode: "percent",
        shares: [
          { memberId: 1, percent: "50" },
          { memberId: 2, percent: "49.99" },
        ],
      }),
    ).toThrow(/99\.99%/);
  });

  it("rejects duplicate and empty member lists", () => {
    expect(() => resolveSplit(100, { mode: "equal", memberIds: [] })).toThrow(MoneyError);
    expect(() => resolveSplit(100, { mode: "equal", memberIds: [1, 1] })).toThrow(MoneyError);
  });
});

describe("computeBalances", () => {
  it("nets paid minus owed, payer may be outside the split", () => {
    const b = computeBalances([1, 2, 3], [
      { paidBy: 1, amountCents: 10000, shares: [{ memberId: 2, amountCents: 5000 }, { memberId: 3, amountCents: 5000 }] },
    ]);
    expect(b.map((x) => x.netCents)).toEqual([10000, -5000, -5000]);
  });
});

function applyTransfers(nets: Map<number, number>, transfers: Transfer[]): void {
  for (const t of transfers) {
    expect(t.amountCents).toBeGreaterThan(0);
    nets.set(t.from, nets.get(t.from)! + t.amountCents);
    nets.set(t.to, nets.get(t.to)! - t.amountCents);
  }
  for (const v of nets.values()) expect(Math.abs(v)).toBe(0);
}

describe("settleUp", () => {
  it("$100 three ways: two payments that clear everything", () => {
    const shares = resolveSplit(10000, { mode: "equal", memberIds: [1, 2, 3] });
    const balances = computeBalances([1, 2, 3], [{ paidBy: 1, amountCents: 10000, shares }]);
    const t = settleUp(balances);
    expect(t).toEqual([
      { from: 2, to: 1, amountCents: 3333 },
      { from: 3, to: 1, amountCents: 3333 },
    ]);
  });

  it("beats greedy when zero-sum subgroups exist", () => {
    // Largest-debtor-to-largest-creditor greedy needs 6 transfers here; the optimum is 5
    // because {+8, -4, -4} settles on its own.
    const nets = [600, -300, 200, -400, -500, -400, 800];
    const balances = nets.map((netCents, i) => ({ memberId: i + 1, netCents }));
    const t = settleUp(balances);
    applyTransfers(new Map(balances.map((b) => [b.memberId, b.netCents])), t);
    expect(t.length).toBe(5);
    expect(bruteForceMin(nets)).toBe(5);
  });

  it("matches brute-force optimum on random small groups", () => {
    let seed = 7;
    const rand = (n: number) => (seed = (seed * 1103515245 + 12345) % 2 ** 31) % n;
    for (let t = 0; t < 300; t++) {
      const n = rand(7) + 2;
      const nets = Array.from({ length: n - 1 }, () => (rand(6) - 3) * 100);
      nets.push(-nets.reduce((a, b) => a + b, 0));
      const balances = nets.map((netCents, i) => ({ memberId: i + 1, netCents }));
      const transfers = settleUp(balances);
      applyTransfers(new Map(balances.map((b) => [b.memberId, b.netCents])), transfers);
      expect(transfers.length).toBe(bruteForceMin(nets.filter((v) => v !== 0)));
    }
  });

  it("falls back to greedy for large groups and still clears debts", () => {
    const n = EXACT_SETTLE_LIMIT + 5;
    const nets = Array.from({ length: n - 1 }, (_, i) => (i % 2 ? 1 : -1) * (i + 1) * 37);
    nets.push(-nets.reduce((a, b) => a + b, 0));
    const balances = nets.map((netCents, i) => ({ memberId: i + 1, netCents }));
    const t = settleUp(balances);
    applyTransfers(new Map(balances.map((b) => [b.memberId, b.netCents])), t);
    expect(t.length).toBeLessThanOrEqual(n - 1);
  });

  it("rejects unbalanced input", () => {
    expect(() => settleUp([{ memberId: 1, netCents: 1 }])).toThrow();
  });
});

/** Independent oracle: min transfers = k - max number of disjoint zero-sum subsets (exhaustive). */
function bruteForceMin(nets: number[]): number {
  const k = nets.length;
  const memo = new Map<number, number>();
  const best = (mask: number): number => {
    if (mask === 0) return 0;
    const cached = memo.get(mask);
    if (cached !== undefined) return cached;
    const first = mask & -mask;
    let result = -Infinity;
    // Choose the zero-sum subset containing the lowest remaining person.
    for (let sub = mask; sub; sub = (sub - 1) & mask) {
      if (!(sub & first)) continue;
      let s = 0;
      for (let i = 0; i < k; i++) if (sub & (1 << i)) s += nets[i]!;
      if (s === 0) result = Math.max(result, 1 + best(mask ^ sub));
    }
    memo.set(mask, result);
    return result;
  };
  return k - best((1 << k) - 1);
}

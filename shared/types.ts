// Types shared by the API (server) and the UI (web). All money is integer cents.

export type SplitMode = "equal" | "exact" | "percent";

export interface Member {
  id: number;
  name: string;
  archived: boolean;
}

export interface ExpenseShare {
  memberId: number;
  /** Raw user input: cents for "exact", basis points (1% = 100) for "percent", null for "equal". */
  input: number | null;
  /** Resolved amount this member owes for the expense. */
  amountCents: number;
}

export interface Expense {
  id: number;
  description: string;
  amountCents: number;
  paidBy: number;
  splitMode: SplitMode;
  isPayment: boolean;
  version: number;
  createdAt: string;
  updatedAt: string;
  shares: ExpenseShare[];
}

export interface Balance {
  memberId: number;
  paidCents: number;
  owedCents: number;
  /** paid - owed. Positive: the group owes this member. Negative: member owes the group. */
  netCents: number;
}

export interface Transfer {
  from: number;
  to: number;
  amountCents: number;
}

export interface GroupSnapshot {
  id: string;
  name: string;
  createdAt: string;
  members: Member[];
  expenses: Expense[];
  balances: Balance[];
  settlements: Transfer[];
}

export interface ExpenseRevision {
  version: number;
  action: "create" | "update" | "delete";
  createdAt: string;
  snapshot: Omit<Expense, "version" | "createdAt" | "updatedAt">;
}

/** Request body for creating/updating an expense. Amounts are decimal strings, e.g. "100.00". */
export interface ExpenseInput {
  description: string;
  amount: string;
  paidBy: number;
  isPayment?: boolean;
  split:
    | { mode: "equal"; memberIds: number[] }
    | { mode: "exact"; shares: { memberId: number; amount: string }[] }
    | { mode: "percent"; shares: { memberId: number; percent: string }[] };
}

export interface ApiError {
  error: string;
  details?: unknown;
}

import type { ApiError, Expense, ExpenseInput, ExpenseRevision, GroupSnapshot } from "../../shared/types.ts";

export class RequestError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`/api${path}`, {
    method,
    headers: body === undefined ? undefined : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (res.status === 204) return undefined as T;
  const data = await res.json().catch(() => ({ error: res.statusText }));
  if (!res.ok) {
    const err = data as ApiError;
    const details = Array.isArray(err.details)
      ? `: ${(err.details as { path: string; message: string }[]).map((d) => `${d.path} ${d.message}`).join(", ")}`
      : "";
    throw new RequestError(res.status, `${err.error}${details}`);
  }
  return data as T;
}

export const api = {
  createGroup: (name: string, members: string[]) => request<GroupSnapshot>("POST", "/groups", { name, members }),
  getGroup: (id: string) => request<GroupSnapshot>("GET", `/groups/${id}`),
  addMember: (id: string, name: string) => request<GroupSnapshot>("POST", `/groups/${id}/members`, { name }),
  removeMember: (id: string, memberId: number) => request<GroupSnapshot>("DELETE", `/groups/${id}/members/${memberId}`),
  createExpense: (id: string, input: ExpenseInput) => request<Expense>("POST", `/groups/${id}/expenses`, input),
  updateExpense: (id: string, expenseId: number, input: ExpenseInput & { version: number }) =>
    request<Expense>("PUT", `/groups/${id}/expenses/${expenseId}`, input),
  deleteExpense: (id: string, expenseId: number, version: number) =>
    request<void>("DELETE", `/groups/${id}/expenses/${expenseId}?version=${version}`),
  history: (id: string, expenseId: number) =>
    request<ExpenseRevision[]>("GET", `/groups/${id}/expenses/${expenseId}/history`),
};

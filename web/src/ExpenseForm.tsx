import { type FormEvent, useState } from "react";
import {
  centsToDecimal,
  formatCents,
  MoneyError,
  normalizeDecimalInput,
  parseCents,
  resolveSplit,
  type SplitInput,
} from "../../shared/money.ts";
import type { Expense, ExpenseRevision, Member, SplitMode } from "../../shared/types.ts";
import { api, RequestError } from "./api.ts";

interface Props {
  groupId: string;
  members: Member[];
  allMembers: Member[];
  defaultPayer: number | null;
  expense: Expense | null;
  onClose: () => void;
  onSaved: () => void | Promise<void>;
}

const bpToPercent = (bp: number) => (bp % 100 === 0 ? String(bp / 100) : `${Math.floor(bp / 100)}.${String(bp % 100).padStart(2, "0")}`);

export function ExpenseForm({ groupId, members, allMembers, defaultPayer, expense, onClose, onSaved }: Props) {
  const inputFor = (mode: SplitMode) =>
    Object.fromEntries(
      expense && expense.splitMode === mode
        ? expense.shares.map((s) => [s.memberId, mode === "exact" ? centsToDecimal(s.input ?? 0) : bpToPercent(s.input ?? 0)])
        : [],
    ) as Record<number, string>;

  const [amount, setAmount] = useState(expense ? centsToDecimal(expense.amountCents) : "");
  const [description, setDescription] = useState(expense?.description ?? "");
  const [paidBy, setPaidBy] = useState<number | null>(
    expense?.paidBy ?? (members.some((m) => m.id === defaultPayer) ? defaultPayer : (members[0]?.id ?? null)),
  );
  const [mode, setMode] = useState<SplitMode>(expense?.splitMode ?? "equal");
  const [equalIds, setEqualIds] = useState<number[]>(
    expense?.splitMode === "equal" ? expense.shares.map((s) => s.memberId) : members.map((m) => m.id),
  );
  const [exact, setExact] = useState<Record<number, string>>(() => inputFor("exact"));
  const [percent, setPercent] = useState<Record<number, string>>(() => inputFor("percent"));
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [history, setHistory] = useState<ExpenseRevision[] | null>(null);

  const split: SplitInput =
    mode === "equal"
      ? { mode, memberIds: members.filter((m) => equalIds.includes(m.id)).map((m) => m.id) }
      : mode === "exact"
        ? {
            mode,
            shares: members
              .filter((m) => exact[m.id]?.trim())
              .map((m) => ({ memberId: m.id, amount: normalizeDecimalInput(exact[m.id]!) })),
          }
        : {
            mode,
            shares: members
              .filter((m) => percent[m.id]?.trim())
              .map((m) => ({ memberId: m.id, percent: normalizeDecimalInput(percent[m.id]!) })),
          };
  const normalizedAmount = normalizeDecimalInput(amount);

  // Live preview with the same rounding code the server uses; the server stays authoritative.
  let totalCents: number | null = null;
  let preview: Map<number, number> | null = null;
  let previewError: string | null = null;
  try {
    totalCents = parseCents(normalizedAmount || "0");
    if (totalCents > 0) preview = new Map(resolveSplit(totalCents, split).map((s) => [s.memberId, s.amountCents]));
  } catch (err) {
    if (!(err instanceof MoneyError)) throw err;
    previewError = err.message;
  }

  const remaining = (() => {
    if (mode === "exact" && totalCents !== null) {
      let sum = 0;
      for (const m of members) {
        try {
          sum += exact[m.id]?.trim() ? parseCents(normalizeDecimalInput(exact[m.id]!)) : 0;
        } catch {
          return null;
        }
      }
      return `${formatCents(totalCents - sum)} left`;
    }
    if (mode === "percent") {
      const sum = members.reduce((a, m) => a + (Number(normalizeDecimalInput(percent[m.id] ?? "")) || 0), 0);
      return `${(100 - sum).toFixed(2).replace(/\.00$/, "")}% left`;
    }
    return null;
  })();

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (paidBy === null) return;
    setBusy(true);
    setError(null);
    const input = { description: description.trim() || "Expense", amount: normalizedAmount, paidBy, split };
    try {
      if (expense) await api.updateExpense(groupId, expense.id, { ...input, version: expense.version });
      else await api.createExpense(groupId, input);
      await onSaved();
    } catch (err) {
      setError(
        err instanceof RequestError && err.status === 409
          ? "Someone else changed this expense. Close and reopen to see the latest version."
          : (err as Error).message,
      );
      setBusy(false);
    }
  }

  async function remove() {
    if (!expense || !confirm(`Delete “${expense.description}”?`)) return;
    setBusy(true);
    try {
      await api.deleteExpense(groupId, expense.id, expense.version);
      await onSaved();
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  }

  const nameOf = (id: number) => allMembers.find((m) => m.id === id)?.name ?? "?";

  return (
    <div className="sheet-backdrop" onClick={onClose}>
      <form className="sheet stack" onSubmit={submit} onClick={(e) => e.stopPropagation()}>
        <header className="row">
          <h2>{expense ? "Edit expense" : "Add expense"}</h2>
          <button type="button" className="ghost" onClick={onClose} aria-label="Close">
            ✕
          </button>
        </header>

        <label className="amount-input">
          <span>$</span>
          <input
            inputMode="decimal"
            autoFocus={!expense}
            placeholder="0.00"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            aria-label="Amount"
            required
          />
        </label>

        <input
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          placeholder="What was it? (e.g. Dinner)"
          aria-label="Description"
          maxLength={120}
        />

        <fieldset>
          <legend>Paid by</legend>
          <div className="chips">
            {members.map((m) => (
              <button
                type="button"
                key={m.id}
                className={`chip toggle ${paidBy === m.id ? "on" : ""}`}
                onClick={() => setPaidBy(m.id)}
              >
                {m.name}
              </button>
            ))}
          </div>
        </fieldset>

        <fieldset>
          <legend>Split</legend>
          <div className="segmented" role="tablist">
            {(["equal", "exact", "percent"] as const).map((m) => (
              <button type="button" key={m} className={mode === m ? "on" : ""} onClick={() => setMode(m)}>
                {m === "equal" ? "Equally" : m === "exact" ? "Amounts" : "Percent"}
              </button>
            ))}
          </div>

          <ul className="list split-list">
            {members.map((m) => (
              <li key={m.id} className="row">
                {mode === "equal" ? (
                  <label className="check">
                    <input
                      type="checkbox"
                      checked={equalIds.includes(m.id)}
                      onChange={(e) =>
                        setEqualIds(e.target.checked ? [...equalIds, m.id] : equalIds.filter((x) => x !== m.id))
                      }
                    />
                    {m.name}
                  </label>
                ) : (
                  <label className="share">
                    {m.name}
                    <input
                      inputMode="decimal"
                      placeholder={mode === "exact" ? "0.00" : "0"}
                      value={(mode === "exact" ? exact : percent)[m.id] ?? ""}
                      onChange={(e) => {
                        const v = e.target.value;
                        if (mode === "exact") setExact({ ...exact, [m.id]: v });
                        else setPercent({ ...percent, [m.id]: v });
                      }}
                      aria-label={`${m.name} ${mode === "exact" ? "amount" : "percent"}`}
                    />
                    {mode === "percent" && <span className="muted">%</span>}
                  </label>
                )}
                <span className="amount muted">{preview?.has(m.id) ? formatCents(preview.get(m.id)!) : ""}</span>
              </li>
            ))}
          </ul>
          {remaining && <p className="muted right">{remaining}</p>}
          {amount && previewError && <p className="warn">{previewError}</p>}
        </fieldset>

        {error && <p className="error">{error}</p>}

        <button className="primary" disabled={busy || paidBy === null}>
          {expense ? "Save changes" : "Add expense"}
        </button>

        {expense && (
          <div className="row">
            <button type="button" className="danger" onClick={remove} disabled={busy}>
              Delete
            </button>
            <button
              type="button"
              className="ghost"
              onClick={async () => setHistory(await api.history(groupId, expense.id))}
            >
              History
            </button>
          </div>
        )}

        {history && (
          <ol className="history">
            {history.map((h) => (
              <li key={h.version}>
                <b>v{h.version}</b> {h.action} · {new Date(h.createdAt).toLocaleString()} ·{" "}
                {formatCents(h.snapshot.amountCents)} paid by {nameOf(h.snapshot.paidBy)} ({h.snapshot.splitMode})
              </li>
            ))}
          </ol>
        )}
      </form>
    </div>
  );
}

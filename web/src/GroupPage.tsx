import { type FormEvent, useCallback, useEffect, useState } from "react";
import { formatCents } from "../../shared/money.ts";
import type { Expense, GroupSnapshot, Transfer } from "../../shared/types.ts";
import { api } from "./api.ts";
import { ExpenseForm } from "./ExpenseForm.tsx";
import { getMe, navigate, rememberGroup, setMe } from "./local.ts";

type Editing = { kind: "new" } | { kind: "edit"; expense: Expense } | null;

export function GroupPage({ groupId }: { groupId: string }) {
  const [group, setGroup] = useState<GroupSnapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<Editing>(null);
  const [storedMe, setMeState] = useState<number | null>(() => getMe(groupId));
  const [newMember, setNewMember] = useState("");
  const [notice, setNotice] = useState<string | null>(null);
  const [paying, setPaying] = useState<string | null>(null);

  const reload = useCallback(async () => {
    try {
      const g = await api.getGroup(groupId);
      setGroup(g);
      setError(null);
      rememberGroup({ id: g.id, name: g.name });
    } catch (err) {
      setError((err as Error).message);
    }
  }, [groupId]);

  // Live sync: the server pushes a "change" event whenever anyone edits this group. The stream is
  // only open while the tab is visible: browsers allow ~6 HTTP/1.1 connections per host, so
  // background tabs holding streams would eventually block requests from the foreground tab.
  useEffect(() => {
    let events: EventSource | null = null;
    const connect = () => {
      events?.close();
      events = new EventSource(`/api/groups/${groupId}/events`);
      events.addEventListener("change", () => void reload());
    };
    const onVisibility = () => {
      if (document.visibilityState === "visible") {
        connect();
        void reload();
      } else {
        events?.close();
        events = null;
      }
    };
    void reload();
    if (document.visibilityState === "visible") connect();
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      events?.close();
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [groupId, reload]);

  if (!group) {
    return <main className="page">{error ? <p className="error">{error}</p> : <p className="muted">Loading…</p>}</main>;
  }

  const active = group.members.filter((m) => !m.archived);
  // The remembered "me" may have been removed from the group on another device.
  const me = active.some((m) => m.id === storedMe) ? storedMe : null;
  const nameOf = (id: number) => group.members.find((m) => m.id === id)?.name ?? "?";

  // Always refetch afterwards: a failed action (409, removed member) usually means our view is stale.
  async function act(fn: () => Promise<unknown>) {
    setNotice(null);
    try {
      await fn();
    } catch (err) {
      setNotice((err as Error).message);
    }
    await reload();
  }

  async function recordPayment(t: Transfer) {
    if (paying) return;
    setPaying(`${t.from}-${t.to}`);
    await act(() => api.settle(groupId, t));
    setPaying(null);
  }

  async function addMember(e: FormEvent) {
    e.preventDefault();
    const name = newMember.trim();
    if (!name) return;
    await act(() => api.addMember(groupId, name));
    setNewMember("");
  }

  async function share() {
    // share/clipboard only exist in secure contexts (https or localhost), not on http://<LAN-IP>.
    const url = location.href;
    if (navigator.share) {
      await navigator.share({ title: group!.name, url }).catch(() => {});
      return;
    }
    try {
      await navigator.clipboard.writeText(url);
      setNotice("Link copied");
    } catch {
      setNotice(`Copy this link to share: ${url}`);
    }
  }

  return (
    <main className="page with-fab">
      <header className="topbar">
        <button className="ghost" onClick={() => navigate("/")} aria-label="All groups">
          ‹
        </button>
        <h1>{group.name}</h1>
        <button className="ghost" onClick={share}>
          Share
        </button>
      </header>

      <label className="me">
        I am
        <select
          value={me ?? ""}
          onChange={(e) => {
            const id = Number(e.target.value);
            setMe(groupId, id);
            setMeState(id);
          }}
        >
          <option value="" disabled>
            choose…
          </option>
          {active.map((m) => (
            <option key={m.id} value={m.id}>
              {m.name}
            </option>
          ))}
        </select>
      </label>

      {notice && (
        <p className="notice" role="status" onClick={() => setNotice(null)}>
          {notice}
        </p>
      )}

      <section className="card">
        <h2>Settle up</h2>
        {group.settlements.length === 0 ? (
          <p className="muted">Everyone is square.</p>
        ) : (
          <ul className="list">
            {group.settlements.map((t) => (
              <li key={`${t.from}-${t.to}`} className="row transfer">
                <span>
                  <b>{nameOf(t.from)}</b> pays <b>{nameOf(t.to)}</b>
                </span>
                <span className="amount">{formatCents(t.amountCents)}</span>
                <button className="small" onClick={() => recordPayment(t)} disabled={paying !== null}>
                  Paid
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="card">
        <h2>Balances</h2>
        <ul className="list">
          {group.balances.map((b) => (
            <li key={b.memberId} className="row">
              <span>
                {nameOf(b.memberId)}
                {b.memberId === me && <span className="muted"> (you)</span>}
              </span>
              <span className={b.netCents > 0 ? "pos" : b.netCents < 0 ? "neg" : "muted"}>
                {b.netCents > 0 ? "gets back " : b.netCents < 0 ? "owes " : ""}
                {b.netCents === 0 ? "settled" : formatCents(Math.abs(b.netCents))}
              </span>
            </li>
          ))}
        </ul>
      </section>

      <section className="card">
        <h2>Expenses</h2>
        {group.expenses.length === 0 ? (
          <p className="muted">No expenses yet. Tap “Add expense”.</p>
        ) : (
          <ul className="list">
            {group.expenses.map((e) => (
              <li key={e.id}>
                <button className="expense" onClick={() => setEditing({ kind: "edit", expense: e })}>
                  <span>
                    <span className={e.isPayment ? "payment" : undefined}>{e.description}</span>
                    <small className="muted">
                      {e.isPayment ? "settlement payment" : `${nameOf(e.paidBy)} paid · ${e.splitMode} split`}
                      {e.version > 1 && " · edited"}
                    </small>
                  </span>
                  <span className="amount">{formatCents(e.amountCents)}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="card">
        <h2>Members</h2>
        <ul className="chips">
          {active.map((m) => (
            <li key={m.id} className="chip">
              {m.name}
              <button
                className="chip-x"
                aria-label={`Remove ${m.name}`}
                onClick={() => confirm(`Remove ${m.name}?`) && act(() => api.removeMember(groupId, m.id))}
              >
                ×
              </button>
            </li>
          ))}
        </ul>
        <form className="inline" onSubmit={addMember}>
          <input value={newMember} onChange={(e) => setNewMember(e.target.value)} placeholder="Add member" />
          <button className="small">Add</button>
        </form>
      </section>

      <button className="fab" onClick={() => setEditing({ kind: "new" })} disabled={active.length === 0}>
        + Add expense
      </button>

      {editing && (
        <ExpenseForm
          groupId={groupId}
          members={active}
          allMembers={group.members}
          defaultPayer={me}
          expense={editing.kind === "edit" ? editing.expense : null}
          onClose={() => setEditing(null)}
          onSaved={async () => {
            setEditing(null);
            await reload();
          }}
        />
      )}
    </main>
  );
}

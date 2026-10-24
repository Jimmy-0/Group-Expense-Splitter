import { type FormEvent, useState } from "react";
import { api } from "./api.ts";
import { navigate, recentGroups, rememberGroup } from "./local.ts";

export function Home() {
  const [name, setName] = useState("");
  const [members, setMembers] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const recent = recentGroups();

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const names = members
        .split(/[\n,]/)
        .map((m) => m.trim())
        .filter(Boolean);
      const group = await api.createGroup(name, names);
      rememberGroup({ id: group.id, name: group.name });
      navigate(`/g/${group.id}`);
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  }

  return (
    <main className="page">
      <h1 className="brand">Split</h1>
      <p className="muted">Share trip costs with friends. No sign-up: share the group link.</p>

      <form className="card stack" onSubmit={submit}>
        <h2>New group</h2>
        <label>
          Group name
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Tokyo 2026" required />
        </label>
        <label>
          Members <span className="muted">(one per line or comma-separated)</span>
          <textarea
            value={members}
            onChange={(e) => setMembers(e.target.value)}
            rows={4}
            placeholder={"Ann\nBob\nCat"}
            required
          />
        </label>
        {error && <p className="error">{error}</p>}
        <button className="primary" disabled={busy}>
          Create group
        </button>
      </form>

      {recent.length > 0 && (
        <section className="card">
          <h2>Your groups</h2>
          <ul className="list">
            {recent.map((g) => (
              <li key={g.id}>
                <a
                  href={`/g/${g.id}`}
                  onClick={(e) => {
                    e.preventDefault();
                    navigate(`/g/${g.id}`);
                  }}
                >
                  {g.name}
                </a>
              </li>
            ))}
          </ul>
        </section>
      )}
    </main>
  );
}

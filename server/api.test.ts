import { once } from "node:events";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Expense, ExpenseRevision, GroupSnapshot } from "../shared/types.ts";
import { createApp } from "./app.ts";
import { openDb } from "./db.ts";

let server: Server;
let base: string;
let tmp: string;

beforeAll(async () => {
  tmp = mkdtempSync(join(tmpdir(), "splitter-"));
  server = createApp(openDb(join(tmp, "test.db"))).listen(0);
  await once(server, "listening");
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`;
});

afterAll(() => {
  server.close();
  rmSync(tmp, { recursive: true, force: true });
});

async function call<T = any>(method: string, path: string, body?: unknown): Promise<{ status: number; data: T }> {
  const res = await fetch(base + path, {
    method,
    headers: body === undefined ? {} : { "content-type": "application/json" },
    body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, data: text ? JSON.parse(text) : undefined };
}

async function newGroup(...names: string[]) {
  const { status, data } = await call<GroupSnapshot>("POST", "/groups", { name: "Trip", members: names });
  expect(status).toBe(201);
  const ids = Object.fromEntries(data.members.map((m) => [m.name, m.id])) as Record<string, number>;
  return { gid: data.id, ids };
}

const net = (g: GroupSnapshot, id: number) => g.balances.find((b) => b.memberId === id)!.netCents;

describe("groups", () => {
  it("creates and fetches a group", async () => {
    const { gid } = await newGroup("Ann", "Bob");
    const { status, data } = await call<GroupSnapshot>("GET", `/groups/${gid}`);
    expect(status).toBe(200);
    expect(data.members.map((m) => m.name)).toEqual(["Ann", "Bob"]);
    expect(data.settlements).toEqual([]);
  });

  it.each([
    [{ name: "", members: ["A"] }],
    [{ name: "x", members: [] }],
    [{ name: "x", members: ["A", "a"] }],
    [{ name: "x" }],
  ])("rejects %j", async (body) => {
    expect((await call("POST", "/groups", body)).status).toBe(400);
  });

  it("rejects malformed JSON and unknown groups", async () => {
    expect((await call("POST", "/groups", "{nope")).status).toBe(400);
    expect((await call("GET", "/groups/missing")).status).toBe(404);
  });
});

describe("expenses and balances", () => {
  it("$100 split three ways balances to the cent", async () => {
    const { gid, ids } = await newGroup("Ann", "Bob", "Cat");
    const { status } = await call("POST", `/groups/${gid}/expenses`, {
      description: "Dinner",
      amount: "100",
      paidBy: ids.Ann,
      split: { mode: "equal", memberIds: [ids.Ann, ids.Bob, ids.Cat] },
    });
    expect(status).toBe(201);
    const { data: g } = await call<GroupSnapshot>("GET", `/groups/${gid}`);
    expect(g.expenses[0]!.shares.map((s) => s.amountCents)).toEqual([3334, 3333, 3333]);
    expect([net(g, ids.Ann!), net(g, ids.Bob!), net(g, ids.Cat!)]).toEqual([6666, -3333, -3333]);
    expect(g.settlements).toEqual([
      { from: ids.Bob, to: ids.Ann, amountCents: 3333 },
      { from: ids.Cat, to: ids.Ann, amountCents: 3333 },
    ]);
  });

  it("handles exact and percent splits across several expenses", async () => {
    const { gid, ids } = await newGroup("Ann", "Bob", "Cat");
    await call("POST", `/groups/${gid}/expenses`, {
      description: "Hotel",
      amount: "300.00",
      paidBy: ids.Bob,
      split: {
        mode: "exact",
        shares: [
          { memberId: ids.Ann, amount: "150" },
          { memberId: ids.Bob, amount: "100" },
          { memberId: ids.Cat, amount: "50" },
        ],
      },
    });
    await call("POST", `/groups/${gid}/expenses`, {
      description: "Car",
      amount: "10.01",
      paidBy: ids.Cat,
      split: {
        mode: "percent",
        shares: [
          { memberId: ids.Ann, percent: "50" },
          { memberId: ids.Bob, percent: "25" },
          { memberId: ids.Cat, percent: "25" },
        ],
      },
    });
    const { data: g } = await call<GroupSnapshot>("GET", `/groups/${gid}`);
    // Car 1001c at 50/25/25 -> 500.5/250.25/250.25 -> 501/250/250 (Ann has the largest remainder).
    expect([net(g, ids.Ann!), net(g, ids.Bob!), net(g, ids.Cat!)]).toEqual([-15000 - 501, 20000 - 250, -5000 + 1001 - 250]);
    expect(g.balances.reduce((a, b) => a + b.netCents, 0)).toBe(0);
  });

  it.each([
    ["negative amount", { amount: "-5" }],
    ["three decimals", { amount: "1.005" }],
    ["zero", { amount: "0" }],
    ["number instead of string", { amount: 10 }],
    ["exact shares off by a cent", { split: { mode: "exact", shares: [{ memberId: 0, amount: "9.99" }] } }],
    ["percent not 100", { split: { mode: "percent", shares: [{ memberId: 0, percent: "99" }] } }],
    ["unknown split mode", { split: { mode: "shares", memberIds: [] } }],
    ["empty equal split", { split: { mode: "equal", memberIds: [] } }],
    ["empty description", { description: "  " }],
  ])("rejects %s", async (_label, override) => {
    const { gid, ids } = await newGroup("Ann");
    const body = {
      description: "x",
      amount: "10",
      paidBy: ids.Ann,
      split: { mode: "equal", memberIds: [ids.Ann] },
      ...override,
    };
    // Patch placeholder memberId 0 with the real id.
    const json = JSON.stringify(body).replaceAll('"memberId":0', `"memberId":${ids.Ann}`);
    const { status, data } = await call("POST", `/groups/${gid}/expenses`, json);
    expect(status).toBe(400);
    expect(typeof data.error).toBe("string");
  });

  it("rejects members from another group", async () => {
    const a = await newGroup("Ann");
    const b = await newGroup("Zed");
    const { status } = await call("POST", `/groups/${a.gid}/expenses`, {
      description: "x",
      amount: "10",
      paidBy: b.ids.Zed,
      split: { mode: "equal", memberIds: [a.ids.Ann] },
    });
    expect(status).toBe(400);
  });
});

describe("edit, delete, history", () => {
  it("updates balances on edit and delete, keeps revisions, enforces versions", async () => {
    const { gid, ids } = await newGroup("Ann", "Bob");
    const create = {
      description: "Taxi",
      amount: "20",
      paidBy: ids.Ann,
      split: { mode: "equal", memberIds: [ids.Ann, ids.Bob] },
    };
    const { data: e } = await call<Expense>("POST", `/groups/${gid}/expenses`, create);
    expect(e.version).toBe(1);

    const { status: s1, data: e2 } = await call<Expense>("PUT", `/groups/${gid}/expenses/${e.id}`, {
      ...create,
      amount: "30",
      paidBy: ids.Bob,
      version: 1,
    });
    expect(s1).toBe(200);
    expect(e2.version).toBe(2);
    let { data: g } = await call<GroupSnapshot>("GET", `/groups/${gid}`);
    expect(net(g, ids.Ann!)).toBe(-1500);
    expect(net(g, ids.Bob!)).toBe(1500);

    // A second browser still holding version 1 must not overwrite the newer edit.
    const stale = await call("PUT", `/groups/${gid}/expenses/${e.id}`, { ...create, version: 1 });
    expect(stale.status).toBe(409);
    expect(stale.data.details.current.version).toBe(2);
    expect((await call("DELETE", `/groups/${gid}/expenses/${e.id}?version=1`)).status).toBe(409);
    expect((await call("DELETE", `/groups/${gid}/expenses/${e.id}`)).status).toBe(400);

    expect((await call("DELETE", `/groups/${gid}/expenses/${e.id}?version=2`)).status).toBe(204);
    ({ data: g } = await call<GroupSnapshot>("GET", `/groups/${gid}`));
    expect(g.expenses).toEqual([]);
    expect(g.balances.every((b) => b.netCents === 0)).toBe(true);
    expect((await call("PUT", `/groups/${gid}/expenses/${e.id}`, { ...create, version: 3 })).status).toBe(404);

    const { data: history } = await call<ExpenseRevision[]>("GET", `/groups/${gid}/expenses/${e.id}/history`);
    expect(history.map((h) => [h.version, h.action, h.snapshot.amountCents])).toEqual([
      [1, "create", 2000],
      [2, "update", 3000],
      [3, "delete", 3000],
    ]);
  });

  it("a failed edit leaves the previous splits intact", async () => {
    const { gid, ids } = await newGroup("Ann", "Bob");
    const { data: e } = await call<Expense>("POST", `/groups/${gid}/expenses`, {
      description: "Taxi",
      amount: "20",
      paidBy: ids.Ann,
      split: { mode: "equal", memberIds: [ids.Ann, ids.Bob] },
    });
    const bad = await call("PUT", `/groups/${gid}/expenses/${e.id}`, {
      description: "Taxi",
      amount: "20",
      paidBy: ids.Ann,
      version: 1,
      split: { mode: "exact", shares: [{ memberId: ids.Ann, amount: "5" }] },
    });
    expect(bad.status).toBe(400);
    const { data: g } = await call<GroupSnapshot>("GET", `/groups/${gid}`);
    expect(g.expenses[0]!.version).toBe(1);
    expect(g.expenses[0]!.shares.map((s) => s.amountCents)).toEqual([1000, 1000]);
  });
});

describe("members", () => {
  it("adds members, blocks duplicates, archives only when unused", async () => {
    const { gid, ids } = await newGroup("Ann", "Bob");
    const { status, data } = await call<GroupSnapshot>("POST", `/groups/${gid}/members`, { name: "Cat" });
    expect(status).toBe(201);
    const cat = data.members.find((m) => m.name === "Cat")!.id;
    expect((await call("POST", `/groups/${gid}/members`, { name: "ann" })).status).toBe(409);

    const { data: e } = await call<Expense>("POST", `/groups/${gid}/expenses`, {
      description: "x",
      amount: "9",
      paidBy: ids.Ann,
      split: { mode: "equal", memberIds: [ids.Bob, cat] },
    });
    expect((await call("DELETE", `/groups/${gid}/members/${cat}`)).status).toBe(409);
    await call("DELETE", `/groups/${gid}/expenses/${e.id}?version=1`);
    const removed = await call<GroupSnapshot>("DELETE", `/groups/${gid}/members/${cat}`);
    expect(removed.status).toBe(200);
    expect(removed.data.members.find((m) => m.id === cat)!.archived).toBe(true);
    expect(removed.data.balances.some((b) => b.memberId === cat)).toBe(false);

    // Archived members cannot be used in new expenses, and their name is free again.
    const reuse = await call("POST", `/groups/${gid}/expenses`, {
      description: "x",
      amount: "9",
      paidBy: cat,
      split: { mode: "equal", memberIds: [ids.Ann] },
    });
    expect(reuse.status).toBe(400);
    expect((await call("POST", `/groups/${gid}/members`, { name: "Cat" })).status).toBe(201);
  });
});

describe("persistence and live updates", () => {
  it("survives reopening the database", async () => {
    const path = join(tmp, "persist.db");
    const app1 = createApp(openDb(path)).listen(0);
    await once(app1, "listening");
    const url1 = `http://127.0.0.1:${(app1.address() as AddressInfo).port}/api`;
    const created = (await (
      await fetch(`${url1}/groups`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: "Persist", members: ["Ann"] }),
      })
    ).json()) as GroupSnapshot;
    app1.close();

    const app2 = createApp(openDb(path)).listen(0);
    await once(app2, "listening");
    const res = await fetch(`http://127.0.0.1:${(app2.address() as AddressInfo).port}/api/groups/${created.id}`);
    expect(((await res.json()) as GroupSnapshot).name).toBe("Persist");
    app2.close();
  });

  it("pushes a change event to other subscribers", async () => {
    const { gid, ids } = await newGroup("Ann");
    const controller = new AbortController();
    const res = await fetch(`${base}/groups/${gid}/events`, { signal: controller.signal });
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    await reader.read(); // ": connected"

    await call("POST", `/groups/${gid}/expenses`, {
      description: "x",
      amount: "1",
      paidBy: ids.Ann,
      split: { mode: "equal", memberIds: [ids.Ann] },
    });
    const { value } = await reader.read();
    expect(decoder.decode(value)).toContain("event: change");
    controller.abort();
  });
});

describe("edge cases", () => {
  it("records a settle-up payment once even if 'Paid' is pressed twice concurrently", async () => {
    const { gid, ids } = await newGroup("Ann", "Bob");
    await call("POST", `/groups/${gid}/expenses`, {
      description: "x",
      amount: "10",
      paidBy: ids.Ann,
      split: { mode: "equal", memberIds: [ids.Ann, ids.Bob] },
    });
    const transfer = { from: ids.Bob, to: ids.Ann, amountCents: 500 };
    const results = await Promise.all([
      call("POST", `/groups/${gid}/settlements`, transfer),
      call("POST", `/groups/${gid}/settlements`, transfer),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual([201, 409]);
    const { data: g } = await call<GroupSnapshot>("GET", `/groups/${gid}`);
    expect(g.settlements).toEqual([]);
    const payment = g.expenses.find((e) => e.isPayment)!;
    expect(payment.description).toBe("Bob paid Ann");
    expect(payment.shares).toEqual([{ memberId: ids.Ann, input: 500, amountCents: 500 }]);
  });

  it("rejects a payment that is not in the current plan", async () => {
    const { gid, ids } = await newGroup("Ann", "Bob");
    const { status } = await call("POST", `/groups/${gid}/settlements`, { from: ids.Bob, to: ids.Ann, amountCents: 100 });
    expect(status).toBe(409);
  });

  it("editing a payment keeps it marked as a payment", async () => {
    const { gid, ids } = await newGroup("Ann", "Bob");
    await call("POST", `/groups/${gid}/expenses`, {
      description: "x",
      amount: "10",
      paidBy: ids.Ann,
      split: { mode: "equal", memberIds: [ids.Ann, ids.Bob] },
    });
    const { data: p } = await call<Expense>("POST", `/groups/${gid}/settlements`, {
      from: ids.Bob,
      to: ids.Ann,
      amountCents: 500,
    });
    const { data: edited } = await call<Expense>("PUT", `/groups/${gid}/expenses/${p.id}`, {
      description: "Bob paid Ann (cash)",
      amount: "5",
      paidBy: ids.Bob,
      version: 1,
      split: { mode: "exact", shares: [{ memberId: ids.Ann, amount: "5" }] },
    });
    expect(edited.isPayment).toBe(true);
  });

  it("treats member names case-insensitively beyond ASCII, on every path", async () => {
    expect((await call("POST", "/groups", { name: "t", members: ["Émile", "émile"] })).status).toBe(400);
    const { gid } = await newGroup("Émile");
    expect((await call("POST", `/groups/${gid}/members`, { name: "émile" })).status).toBe(409);
    expect((await call("POST", `/groups/${gid}/members`, { name: "E\u0301MILE" })).status).toBe(409);
  });

  it("caps a group at 50 active members so an equal split can include everyone", async () => {
    const { gid } = await newGroup(...Array.from({ length: 49 }, (_, i) => `M${i}`));
    expect((await call("POST", `/groups/${gid}/members`, { name: "M49" })).status).toBe(201);
    const over = await call("POST", `/groups/${gid}/members`, { name: "M50" });
    expect(over.status).toBe(409);
    const { data: g } = await call<GroupSnapshot>("GET", `/groups/${gid}`);
    const all = g.members.map((m) => m.id);
    const { status } = await call("POST", `/groups/${gid}/expenses`, {
      description: "x",
      amount: "100",
      paidBy: all[0],
      split: { mode: "equal", memberIds: all },
    });
    expect(status).toBe(201);
  });

  it("answers an oversized body with 413, not 500", async () => {
    const { status, data } = await call("POST", "/groups", { name: "x".repeat(200_000), members: ["A"] });
    expect(status).toBe(413);
    expect(typeof data.error).toBe("string");
  });

  it("names a removed member when an open form submits them", async () => {
    const { gid, ids } = await newGroup("Ann", "Bob");
    await call("DELETE", `/groups/${gid}/members/${ids.Bob}`);
    const { status, data } = await call("POST", `/groups/${gid}/expenses`, {
      description: "x",
      amount: "10",
      paidBy: ids.Ann,
      split: { mode: "equal", memberIds: [ids.Ann, ids.Bob] },
    });
    expect(status).toBe(400);
    expect(data.error).toContain("Bob");
  });

  it("migrates a database created before name_key existed", () => {
    const path = join(tmp, "legacy.db");
    const legacy = new DatabaseSync(path);
    legacy.exec(`
      CREATE TABLE groups (id TEXT PRIMARY KEY, name TEXT NOT NULL, created_at TEXT NOT NULL);
      CREATE TABLE members (id INTEGER PRIMARY KEY, group_id TEXT NOT NULL, name TEXT NOT NULL,
        created_at TEXT NOT NULL, archived_at TEXT);
      CREATE UNIQUE INDEX members_active_name ON members(group_id, name COLLATE NOCASE) WHERE archived_at IS NULL;
      INSERT INTO groups VALUES ('g', 'Old', 'now');
      INSERT INTO members (group_id, name, created_at) VALUES ('g', 'Émile', 'now');
    `);
    legacy.close();
    const db = openDb(path);
    expect(db.prepare("SELECT name_key FROM members").get()).toEqual({ name_key: "émile" });
    expect(() =>
      db.prepare("INSERT INTO members (group_id, name, name_key, created_at) VALUES ('g', 'ÉMILE', 'émile', 'now')").run(),
    ).toThrow(/UNIQUE/);
    db.close();
  });
});

import { randomBytes } from "node:crypto";
import express, { type NextFunction, type Request, type Response } from "express";
import { z } from "zod";
import { computeBalances, MoneyError, parseCents, resolveSplit, settleUp } from "../shared/money.ts";
import type { Expense, ExpenseRevision, ExpenseShare, GroupSnapshot, Member, SplitMode } from "../shared/types.ts";
import { type Db, transaction } from "./db.ts";

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
  }
}

// ---------- validation ----------

const name = (max: number) => z.string().trim().min(1, "must not be empty").max(max);
const id = z.number().int().positive();
const decimal = z.string().max(20);

const createGroupBody = z.object({
  name: name(60),
  members: z.array(name(40)).min(1, "add at least one member").max(50),
});

const addMemberBody = z.object({ name: name(40) });

const expenseBody = z.object({
  description: name(120),
  amount: decimal,
  paidBy: id,
  isPayment: z.boolean().optional().default(false),
  split: z.discriminatedUnion("mode", [
    z.object({ mode: z.literal("equal"), memberIds: z.array(id).max(50) }),
    z.object({ mode: z.literal("exact"), shares: z.array(z.object({ memberId: id, amount: decimal })).max(50) }),
    z.object({ mode: z.literal("percent"), shares: z.array(z.object({ memberId: id, percent: decimal })).max(50) }),
  ]),
});

const updateExpenseBody = expenseBody.extend({ version: z.number().int().positive() });

function parse<T>(schema: z.ZodType<T>, data: unknown): T {
  const result = schema.safeParse(data);
  if (!result.success) {
    throw new HttpError(
      400,
      "invalid request body",
      result.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })),
    );
  }
  return result.data;
}

// ---------- row types ----------

interface MemberRow {
  id: number;
  name: string;
  archived_at: string | null;
}
interface ExpenseRow {
  id: number;
  description: string;
  amount_cents: number;
  paid_by: number;
  split_mode: SplitMode;
  is_payment: number;
  version: number;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
}
interface SplitRow {
  expense_id: number;
  member_id: number;
  input_value: number | null;
  amount_cents: number;
}

// ---------- live updates ----------

/** Per-group Server-Sent Events fan-out. In-process only (see README). */
export class ChangeFeed {
  private subscribers = new Map<string, Set<Response>>();

  subscribe(groupId: string, res: Response): void {
    let set = this.subscribers.get(groupId);
    if (!set) this.subscribers.set(groupId, (set = new Set()));
    set.add(res);
    res.on("close", () => {
      set.delete(res);
      if (set.size === 0) this.subscribers.delete(groupId);
    });
  }

  publish(groupId: string): void {
    for (const res of this.subscribers.get(groupId) ?? []) res.write(`event: change\ndata: ${Date.now()}\n\n`);
  }
}

// ---------- app ----------

export function createApp(db: Db, feed = new ChangeFeed()) {
  const now = () => new Date().toISOString();

  const requireGroup = (groupId: string) => {
    const row = db.prepare("SELECT id, name, created_at FROM groups WHERE id = ?").get(groupId) as
      | { id: string; name: string; created_at: string }
      | undefined;
    if (!row) throw new HttpError(404, "group not found");
    return row;
  };

  const loadExpense = (groupId: string, expenseId: number): Expense => {
    const row = db
      .prepare("SELECT * FROM expenses WHERE id = ? AND group_id = ? AND deleted_at IS NULL")
      .get(expenseId, groupId) as ExpenseRow | undefined;
    if (!row) throw new HttpError(404, "expense not found");
    const splits = db
      .prepare("SELECT * FROM expense_splits WHERE expense_id = ? ORDER BY rowid")
      .all(expenseId) as unknown as SplitRow[];
    return toExpense(row, splits);
  };

  const snapshot = (groupId: string): GroupSnapshot => {
    const group = requireGroup(groupId);
    const memberRows = db
      .prepare("SELECT id, name, archived_at FROM members WHERE group_id = ? ORDER BY id")
      .all(groupId) as unknown as MemberRow[];
    const expenseRows = db
      .prepare("SELECT * FROM expenses WHERE group_id = ? AND deleted_at IS NULL ORDER BY created_at DESC, id DESC")
      .all(groupId) as unknown as ExpenseRow[];
    const splitRows = db
      .prepare(
        `SELECT s.* FROM expense_splits s JOIN expenses e ON e.id = s.expense_id
         WHERE e.group_id = ? AND e.deleted_at IS NULL ORDER BY s.rowid`,
      )
      .all(groupId) as unknown as SplitRow[];

    const splitsByExpense = new Map<number, SplitRow[]>();
    for (const s of splitRows) {
      const list = splitsByExpense.get(s.expense_id);
      if (list) list.push(s);
      else splitsByExpense.set(s.expense_id, [s]);
    }
    const expenses = expenseRows.map((r) => toExpense(r, splitsByExpense.get(r.id) ?? []));
    const members: Member[] = memberRows.map((m) => ({ id: m.id, name: m.name, archived: m.archived_at !== null }));
    const balances = computeBalances(
      members.filter((m) => !m.archived).map((m) => m.id),
      expenses,
    );
    return {
      id: group.id,
      name: group.name,
      createdAt: group.created_at,
      members,
      expenses,
      balances,
      settlements: settleUp(balances),
    };
  };

  /** Validate an expense against the group and resolve it to per-member cents. */
  const resolveExpense = (groupId: string, body: z.infer<typeof expenseBody>) => {
    let amountCents: number;
    let shares: ExpenseShare[];
    try {
      amountCents = parseCents(body.amount);
      if (amountCents === 0) throw new MoneyError("amount must be greater than zero");
      shares = resolveSplit(amountCents, body.split);
    } catch (err) {
      if (err instanceof MoneyError) throw new HttpError(400, err.message);
      throw err;
    }
    const active = new Set(
      (
        db.prepare("SELECT id FROM members WHERE group_id = ? AND archived_at IS NULL").all(groupId) as {
          id: number;
        }[]
      ).map((r) => r.id),
    );
    if (!active.has(body.paidBy)) throw new HttpError(400, "paidBy is not an active member of this group");
    const stranger = shares.find((s) => !active.has(s.memberId));
    if (stranger) throw new HttpError(400, `member ${stranger.memberId} is not an active member of this group`);
    if (shares.every((s) => s.amountCents === 0)) throw new HttpError(400, "nobody owes anything in this split");
    return { amountCents, shares };
  };

  const writeRevision = (expenseId: number, version: number, action: ExpenseRevision["action"], at: string) => {
    const current = db.prepare("SELECT * FROM expenses WHERE id = ?").get(expenseId) as unknown as ExpenseRow;
    const splits = db
      .prepare("SELECT * FROM expense_splits WHERE expense_id = ? ORDER BY rowid")
      .all(expenseId) as unknown as SplitRow[];
    const { version: _v, createdAt: _c, updatedAt: _u, ...snap } = toExpense(current, splits);
    db.prepare("INSERT INTO expense_revisions (expense_id, version, action, snapshot, created_at) VALUES (?, ?, ?, ?, ?)").run(
      expenseId,
      version,
      action,
      JSON.stringify(snap),
      at,
    );
  };

  const insertSplits = (expenseId: number, shares: ExpenseShare[]) => {
    const stmt = db.prepare(
      "INSERT INTO expense_splits (expense_id, member_id, input_value, amount_cents) VALUES (?, ?, ?, ?)",
    );
    for (const s of shares) stmt.run(expenseId, s.memberId, s.input, s.amountCents);
  };

  const assertVersion = (groupId: string, expenseId: number, version: number) => {
    const current = loadExpense(groupId, expenseId);
    if (current.version !== version) {
      throw new HttpError(409, "this expense was changed by someone else; reload and try again", { current });
    }
  };

  const app = express();
  app.use(express.json({ limit: "100kb" }));

  app.post("/api/groups", (req, res) => {
    const body = parse(createGroupBody, req.body);
    const lower = body.members.map((m) => m.toLowerCase());
    if (new Set(lower).size !== lower.length) throw new HttpError(400, "member names must be unique");
    const groupId = randomBytes(9).toString("base64url");
    const at = now();
    transaction(db, () => {
      db.prepare("INSERT INTO groups (id, name, created_at) VALUES (?, ?, ?)").run(groupId, body.name, at);
      const stmt = db.prepare("INSERT INTO members (group_id, name, created_at) VALUES (?, ?, ?)");
      for (const m of body.members) stmt.run(groupId, m, at);
    });
    res.status(201).json(snapshot(groupId));
  });

  app.get("/api/groups/:groupId", (req, res) => {
    res.json(snapshot(req.params.groupId));
  });

  app.get("/api/groups/:groupId/events", (req, res) => {
    requireGroup(req.params.groupId);
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });
    res.write(": connected\n\n");
    feed.subscribe(req.params.groupId, res);
    const heartbeat = setInterval(() => res.write(": ping\n\n"), 25_000);
    res.on("close", () => clearInterval(heartbeat));
  });

  app.post("/api/groups/:groupId/members", (req, res) => {
    const { groupId } = req.params;
    requireGroup(groupId);
    const body = parse(addMemberBody, req.body);
    try {
      db.prepare("INSERT INTO members (group_id, name, created_at) VALUES (?, ?, ?)").run(groupId, body.name, now());
    } catch (err) {
      if (String(err).includes("UNIQUE")) throw new HttpError(409, `a member named "${body.name}" already exists`);
      throw err;
    }
    feed.publish(groupId);
    res.status(201).json(snapshot(groupId));
  });

  app.delete("/api/groups/:groupId/members/:memberId", (req, res) => {
    const { groupId } = req.params;
    requireGroup(groupId);
    const memberId = Number(req.params.memberId);
    const member = db
      .prepare("SELECT id FROM members WHERE id = ? AND group_id = ? AND archived_at IS NULL")
      .get(memberId, groupId);
    if (!member) throw new HttpError(404, "member not found");
    const used = db
      .prepare(
        `SELECT 1 FROM expenses e WHERE e.group_id = ? AND e.deleted_at IS NULL
           AND (e.paid_by = ? OR EXISTS (SELECT 1 FROM expense_splits s WHERE s.expense_id = e.id AND s.member_id = ?))
         LIMIT 1`,
      )
      .get(groupId, memberId, memberId);
    if (used) throw new HttpError(409, "this member is part of existing expenses; edit or delete those first");
    // Archive instead of delete so deleted expenses and revisions still resolve the name.
    db.prepare("UPDATE members SET archived_at = ? WHERE id = ?").run(now(), memberId);
    feed.publish(groupId);
    res.json(snapshot(groupId));
  });

  app.post("/api/groups/:groupId/expenses", (req, res) => {
    const { groupId } = req.params;
    requireGroup(groupId);
    const body = parse(expenseBody, req.body);
    const { amountCents, shares } = resolveExpense(groupId, body);
    const at = now();
    const expenseId = transaction(db, () => {
      const { lastInsertRowid } = db
        .prepare(
          `INSERT INTO expenses (group_id, description, amount_cents, paid_by, split_mode, is_payment, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(groupId, body.description, amountCents, body.paidBy, body.split.mode, body.isPayment ? 1 : 0, at, at);
      const expenseId = Number(lastInsertRowid);
      insertSplits(expenseId, shares);
      writeRevision(expenseId, 1, "create", at);
      return expenseId;
    });
    feed.publish(groupId);
    res.status(201).json(loadExpense(groupId, expenseId));
  });

  app.put("/api/groups/:groupId/expenses/:expenseId", (req, res) => {
    const { groupId } = req.params;
    requireGroup(groupId);
    const expenseId = Number(req.params.expenseId);
    const body = parse(updateExpenseBody, req.body);
    const { amountCents, shares } = resolveExpense(groupId, body);
    const at = now();
    transaction(db, () => {
      assertVersion(groupId, expenseId, body.version);
      db.prepare(
        `UPDATE expenses SET description = ?, amount_cents = ?, paid_by = ?, split_mode = ?, is_payment = ?,
           version = version + 1, updated_at = ? WHERE id = ?`,
      ).run(body.description, amountCents, body.paidBy, body.split.mode, body.isPayment ? 1 : 0, at, expenseId);
      db.prepare("DELETE FROM expense_splits WHERE expense_id = ?").run(expenseId);
      insertSplits(expenseId, shares);
      writeRevision(expenseId, body.version + 1, "update", at);
    });
    feed.publish(groupId);
    res.json(loadExpense(groupId, expenseId));
  });

  app.delete("/api/groups/:groupId/expenses/:expenseId", (req, res) => {
    const { groupId } = req.params;
    requireGroup(groupId);
    const expenseId = Number(req.params.expenseId);
    const version = Number(req.query.version);
    if (!Number.isInteger(version) || version < 1) throw new HttpError(400, "version query parameter is required");
    const at = now();
    transaction(db, () => {
      assertVersion(groupId, expenseId, version);
      db.prepare("UPDATE expenses SET deleted_at = ?, updated_at = ?, version = version + 1 WHERE id = ?").run(
        at,
        at,
        expenseId,
      );
      writeRevision(expenseId, version + 1, "delete", at);
    });
    feed.publish(groupId);
    res.status(204).end();
  });

  app.get("/api/groups/:groupId/expenses/:expenseId/history", (req, res) => {
    const { groupId } = req.params;
    requireGroup(groupId);
    const rows = db
      .prepare(
        `SELECT r.version, r.action, r.snapshot, r.created_at FROM expense_revisions r
         JOIN expenses e ON e.id = r.expense_id WHERE r.expense_id = ? AND e.group_id = ? ORDER BY r.version`,
      )
      .all(Number(req.params.expenseId), groupId) as {
      version: number;
      action: ExpenseRevision["action"];
      snapshot: string;
      created_at: string;
    }[];
    if (rows.length === 0) throw new HttpError(404, "expense not found");
    const history: ExpenseRevision[] = rows.map((r) => ({
      version: r.version,
      action: r.action,
      createdAt: r.created_at,
      snapshot: JSON.parse(r.snapshot),
    }));
    res.json(history);
  });

  app.use("/api", (_req, _res, next) => next(new HttpError(404, "not found")));

  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (err instanceof HttpError) {
      res.status(err.status).json({ error: err.message, details: err.details });
      return;
    }
    if (err instanceof SyntaxError && "body" in err) {
      res.status(400).json({ error: "request body is not valid JSON" });
      return;
    }
    console.error(err);
    res.status(500).json({ error: "internal server error" });
  });

  return app;
}

function toExpense(row: ExpenseRow, splits: SplitRow[]): Expense {
  return {
    id: row.id,
    description: row.description,
    amountCents: row.amount_cents,
    paidBy: row.paid_by,
    splitMode: row.split_mode,
    isPayment: row.is_payment === 1,
    version: row.version,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    shares: splits.map((s) => ({ memberId: s.member_id, input: s.input_value, amountCents: s.amount_cents })),
  };
}

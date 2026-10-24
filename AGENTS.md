# AGENTS.md

Guidance for AI coding agents working in this repo. Human-facing docs live in `README.md`.

## Run

Requires Node.js >= 22.13 (built-in `node:sqlite`; no database server, nothing native to compile).

```bash
npm install
npm start                          # build UI + serve UI and API on http://localhost:3000
DB_PATH=/tmp/scratch.db npm start  # use a throwaway DB; never touch the user's data/app.db
npm run dev                        # API :3000 with reload + Vite :5173 (proxies /api)
```

- App: http://localhost:3000
- API docs (Swagger UI): http://localhost:3000/api/docs
- OpenAPI spec: http://localhost:3000/api/openapi.json

## Verify before finishing

```bash
npm run typecheck
npm test            # vitest: money unit tests + HTTP integration tests, must all pass
```

For UI changes, also run the app and exercise the flow in two different browsers. Live sync and
conflict handling only show up with two clients.

## Map

```
shared/money.ts     pure money logic: parsing, rounding, splits, balances, settle-up (used by server and UI)
shared/types.ts     API request/response types
shared/names.ts     member-name uniqueness key
server/app.ts       Express routes, zod validation, SSE change feed
server/db.ts        SQLite schema, in-place migrations, transaction helper
server/openapi.ts   OpenAPI 3.1 spec served at /api/docs
server/index.ts     entry point; serves web/dist in production
server/*.test.ts    tests
web/src/            React UI
```

## Invariants (do not break)

- **Money is integer cents.** Requests carry decimal strings (`"10.01"`); never parse money with
  floats or accept JSON numbers for amounts.
- **Splits always sum exactly to the total**, using the largest remainder method in `allocate()`.
  `$100 / 3` must stay `3334, 3333, 3333`.
- **The server is authoritative.** Balances and settle-up are computed server-side. The UI may
  reuse `shared/money.ts` only for previews.
- **Expense writes are transactional and versioned.** Updates and deletes require the current
  `version` (otherwise 409), replace splits, and append to `expense_revisions`. Deletes are soft.
- **Members are archived, never hard-deleted.** Names are unique per group by `name_key`.
- **Settle-up payments go through `POST /settlements`**, which must reject transfers that aren't in
  the current plan (this prevents double recording).
- **Schema changes need a migration** in `server/db.ts`, because existing `data/app.db` files must
  keep working.
- **API changes must update `server/openapi.ts`** and the API table in `README.md`.

## Conventions

- TypeScript strict mode, ESM, `.ts` import extensions.
- Errors: throw `HttpError(status, message)` in routes; 400 validation, 404 missing, 409 conflict.
- Tests cover behavior (rounding, boundaries, conflicts, validation), not implementation details.

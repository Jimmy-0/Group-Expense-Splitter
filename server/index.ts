import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import express from "express";
import { createApp } from "./app.ts";
import { openDb } from "./db.ts";

const port = Number(process.env.PORT ?? 3000);
const dbPath = process.env.DB_PATH ?? fileURLToPath(new URL("../data/app.db", import.meta.url));
const webDist = fileURLToPath(new URL("../web/dist", import.meta.url));

const app = createApp(openDb(dbPath));

// In production the API also serves the built SPA; in dev Vite serves it and proxies /api.
if (existsSync(webDist)) {
  app.use(express.static(webDist));
  app.get(/^(?!\/api\/).*/, (_req, res) => res.sendFile(`${webDist}/index.html`));
}

app.listen(port, () => {
  console.log(`Expense splitter listening on http://localhost:${port} (db: ${dbPath})`);
});

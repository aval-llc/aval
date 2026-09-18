import { createHash } from "node:crypto";
import { readFile, readdir, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { is } from "drizzle-orm";
import { SQLiteTable, getTableConfig } from "drizzle-orm/sqlite-core";

export const sha256 = (value) => createHash("sha256").update(value).digest("hex");
const sourceHash = (value) => sha256(value.replaceAll("\r\n", "\n"));
const sorted = (values) => [...values].sort();
const ident = (value) => `"${value.replaceAll('"', '""')}"`;
const literal = (value) => `'${value.replaceAll("'", "''")}'`;

export async function readHistory(root) {
  const journalText = await readFile(path.join(root, "drizzle/meta/_journal.json"), "utf8");
  const journal = JSON.parse(journalText);
  if (journal.dialect !== "sqlite" || !Array.isArray(journal.entries)) throw new Error("Invalid SQLite migration journal");
  const disk = sorted((await readdir(path.join(root, "drizzle"))).filter((file) => file.endsWith(".sql")));
  const expected = journal.entries.map(({ tag, idx }, position) => {
    if (idx !== position || !/^\d{4}_[a-z0-9_]+$/.test(tag)) throw new Error("Invalid migration order or tag");
    return `${tag}.sql`;
  });
  if (new Set(expected).size !== expected.length || JSON.stringify(sorted(expected)) !== JSON.stringify(disk)) {
    throw new Error("Migration journal and SQL files disagree; inventory cannot be trusted");
  }
  const migrations = await Promise.all(expected.map(async (file, index) => {
    const sql = await readFile(path.join(root, "drizzle", file), "utf8");
    return { index, file, sha256: sourceHash(sql), sql };
  }));
  return { journalSha256: sourceHash(journalText), migrations };
}

async function scanConsumers(root, directory) {
  const found = [];
  for (const entry of await readdir(path.join(root, directory), { withFileTypes: true })) {
    const relative = `${directory}/${entry.name}`;
    if (entry.isDirectory()) found.push(...await scanConsumers(root, relative));
    else if (/\.[cm]?[jt]sx?$/.test(entry.name)) {
      const source = await readFile(path.join(root, relative), "utf8");
      const dependencies = [
        ["getDb", /\bgetDb\s*\(/],
        ["D1 binding", /\b(?:D1Database|D1PreparedStatement)\b|\b(?:env|bindings)\.DB\b/],
        ["SQLite dialect", /drizzle-orm\/(?:sqlite|d1)|\b(?:strftime|unixepoch)\s*\(/],
      ].filter(([, pattern]) => pattern.test(source)).map(([name]) => name);
      if (dependencies.length) found.push({ file: relative, dependencies });
    }
  }
  return found;
}

export async function buildInventory(root) {
  const history = await readHistory(root);
  const schemaPath = path.join(root, "db/schema.ts");
  const schema = await import(pathToFileURL(schemaPath).href);
  const tables = Object.entries(schema).filter(([, table]) => is(table, SQLiteTable)).map(([exportName, table]) => {
    const config = getTableConfig(table);
    return {
      name: config.name, exportName,
      columns: config.columns.map((column) => ({
        name: column.name, sqlType: column.getSQLType(), columnType: column.columnType,
        dataType: column.dataType, notNull: column.notNull, primaryKey: column.primary,
        conversion: column.dataType === "date" ? "timestamptz (epoch milliseconds)"
          : column.dataType === "boolean" ? "boolean (strict 0/1)" : "explicit mapping required",
      })),
      indexes: config.indexes.map(({ config: index }) => ({ name: index.name, unique: index.unique,
        columns: index.columns.map((column) => column.name ?? "<expression>") })).sort((a,b) => a.name.localeCompare(b.name)),
      foreignKeys: config.foreignKeys.map((fk) => {
        const ref = fk.reference();
        return { columns: ref.columns.map((c) => c.name), table: getTableConfig(ref.foreignTable).name,
          foreignColumns: ref.foreignColumns.map((c) => c.name), onDelete: fk.onDelete, onUpdate: fk.onUpdate };
      }),
    };
  }).sort((a,b) => a.name.localeCompare(b.name));
  const sqlite = new DatabaseSync(":memory:");
  try {
    sqlite.exec("PRAGMA foreign_keys = ON");
    for (const migration of history.migrations) sqlite.exec(migration.sql);
    const actualTables = sqlite.prepare("SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map((r) => r.name);
    if (JSON.stringify(actualTables) !== JSON.stringify(tables.map((t) => t.name))) throw new Error("Schema tables disagree with replayed migrations");
    for (const table of tables) {
      const columns = sqlite.prepare(`PRAGMA table_info(${ident(table.name)})`).all();
      for (const column of table.columns) {
        const actual = columns.find((c) => c.name === column.name);
        if (!actual || actual.type.toLowerCase() !== column.sqlType || Boolean(actual.notnull) !== column.notNull || Boolean(actual.pk) !== column.primaryKey) {
          throw new Error(`Schema drift: ${table.name}.${column.name}`);
        }
      }
      if (columns.length !== table.columns.length) throw new Error(`Unclassified columns in ${table.name}`);
      table.replayedColumns = columns.map(({ name, type, notnull, dflt_value, pk }) => ({ name, type, notNull: Boolean(notnull), default: dflt_value, primaryKeyPosition: pk }));
      table.replayedForeignKeys = sqlite.prepare(`PRAGMA foreign_key_list(${ident(table.name)})`).all();
      table.replayedIndexes = sqlite.prepare(`PRAGMA index_list(${ident(table.name)})`).all().map((index) => ({
        name: index.name, unique: Boolean(index.unique), origin: index.origin,
        columns: sqlite.prepare(`PRAGMA index_info(${ident(index.name)})`).all().map((c) => c.name),
      }));
      for (const index of table.indexes) {
        const actual = table.replayedIndexes.find((i) => i.name === index.name);
        if (!actual || actual.unique !== index.unique || JSON.stringify(actual.columns) !== JSON.stringify(index.columns)) throw new Error(`Index drift: ${index.name}`);
      }
      const fkSignatures = (fks) => sorted(fks.map((f) => JSON.stringify([f.columns, f.table, f.foreignColumns, f.onDelete ?? "no action", f.onUpdate ?? "no action"])));
      const replayedFks = Object.values(Object.groupBy(table.replayedForeignKeys, (f) => f.id)).map((group) => {
        const ordered = group.sort((a,b) => a.seq-b.seq);
        return { columns: ordered.map((f) => f.from), table: ordered[0].table, foreignColumns: ordered.map((f) => f.to), onDelete: ordered[0].on_delete.toLowerCase(), onUpdate: ordered[0].on_update.toLowerCase() };
      });
      if (JSON.stringify(fkSignatures(replayedFks)) !== JSON.stringify(fkSignatures(table.foreignKeys))) throw new Error(`Foreign key drift: ${table.name}`);
    }
    const triggers = sqlite.prepare("SELECT name, tbl_name, sql FROM sqlite_schema WHERE type='trigger' ORDER BY name").all().map(({name, tbl_name, sql}) => ({ name, table: tbl_name, sql, sha256: sourceHash(sql) }));
    // db/schema.ts is retained only as the historical D1 inventory source. The
    // deployable database layer lives under db/postgres and must stay SQLite-free.
    const consumers = (await Promise.all(["app", "lib", "db/postgres", "worker"].map((dir) => scanConsumers(root, dir)))).flat().sort((a,b) => a.file.localeCompare(b.file));
    const manifest = { version: 1, sourceHashEncoding: "UTF-8, LF normalized", schemaSha256: sourceHash(await readFile(schemaPath, "utf8")),
      journalSha256: history.journalSha256, counts: { tables: tables.length, migrations: history.migrations.length,
        triggers: triggers.length, getDbFiles: consumers.filter((c) => c.dependencies.includes("getDb")).length },
      migrations: history.migrations.map(({index,file,sha256}) => ({index,file,sha256})), tables, triggers, consumers };
    return { ...manifest, inventorySha256: sha256(JSON.stringify(manifest)) };
  } finally { sqlite.close(); }
}

export function productionPreflightSql(inventory) {
  const queries = ["-- READ ONLY. Counts are sensitive operational metadata; store results privately.",
    "SELECT name, type, sql FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name;",
    inventory.tables.map(({name}) => `SELECT ${literal(name)} AS table_name, count(*) AS row_count FROM ${ident(name)}`).join("\nUNION ALL\n") + ";",
    "PRAGMA page_count;", "PRAGMA page_size;", "PRAGMA foreign_key_check;", "PRAGMA quick_check;"];
  for (const table of inventory.tables) {
    if (table.columns.some((c) => c.name === "status")) queries.push(`SELECT ${literal(table.name)} AS table_name, status, count(*) AS row_count FROM ${ident(table.name)} GROUP BY status;`);
    const totals = table.columns.filter((c) => /(?:_cents|_tokens)$/.test(c.name));
    for (const column of totals) queries.push(`SELECT ${literal(table.name)} AS table_name, ${literal(column.name)} AS column_name, CAST(sum(${ident(column.name)}) AS TEXT) AS total FROM ${ident(table.name)};`);
  }
  queries.push("SELECT organization_id, max(sequence) AS head_sequence FROM answer_audit_log GROUP BY organization_id;",
    "SELECT a.organization_id, a.sequence, a.entry_hash FROM answer_audit_log a WHERE a.sequence = (SELECT max(b.sequence) FROM answer_audit_log b WHERE b.organization_id = a.organization_id);");
  return queries.join("\n\n") + "\n";
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const root = fileURLToPath(new URL("../../", import.meta.url));
  const inventory = await buildInventory(root);
  const output = path.resolve(process.argv[2] ?? path.join(root, "docs/migration/inventory.json"));
  await mkdir(path.dirname(output), { recursive: true });
  await writeFile(output, JSON.stringify(inventory, null, 2) + "\n");
  await writeFile(path.join(path.dirname(output), "production-preflight.sql"), productionPreflightSql(inventory));
  console.log(JSON.stringify({ ...inventory.counts, inventorySha256: inventory.inventorySha256, output }));
}

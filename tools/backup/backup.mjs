// EMON OVERRUNS E-Portal backup: copies every table of the database (as a .sql file that can be loaded again, and as
// .json per table) and every uploaded file from Supabase Storage into BACKUP_FOLDER\YYYY-MM-DD on this PC.
// Settings are read from settings.txt next to this file (see settings.example.txt). Run: node backup.mjs
import fs from "node:fs";
import path from "node:path";
import pg from "pg";

const here = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"));
const cfgFile = path.join(here, "settings.txt");
if (!fs.existsSync(cfgFile)) { console.error("settings.txt is missing: copy settings.example.txt to settings.txt and fill it in."); process.exit(1); }
const cfg = Object.fromEntries(fs.readFileSync(cfgFile, "utf8").split(/\r?\n/).filter((l) => /^[A-Z_]+=/.test(l)).map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1).trim()]));
const day = new Date(Date.now() + 8 * 3600e3).toISOString().slice(0, 10); // Manila date
const out = path.join(cfg.BACKUP_FOLDER || "backup", day);
fs.mkdirSync(path.join(out, "tables"), { recursive: true });
const log = (m) => { console.log(m); fs.appendFileSync(path.join(out, "backup-log.txt"), m + "\n"); };

const lit = (v) => (v === null || v === undefined ? "NULL"
  : typeof v === "number" || typeof v === "boolean" ? String(v)
  : v instanceof Date ? `'${v.toISOString()}'`
  : `'${(typeof v === "object" ? JSON.stringify(v) : String(v)).replace(/'/g, "''")}'`);

async function database() {
  const db = new pg.Client({ connectionString: cfg.DATABASE_URL, ssl: /supabase/.test(cfg.DATABASE_URL) ? { rejectUnauthorized: false } : false });
  await db.connect();
  const tables = (await db.query(`select table_name from information_schema.tables where table_schema = 'public' and table_type = 'BASE TABLE' order by 1`)).rows.map((r) => r.table_name);
  const sql = fs.createWriteStream(path.join(out, "database.sql"));
  sql.write(`-- EMON OVERRUNS E-Portal data, ${day}. Rows of every public table (load into a database that has the same tables).\n`);
  let total = 0;
  for (const t of tables) {
    const { rows } = await db.query(`select * from public."${t}"`);
    fs.writeFileSync(path.join(out, "tables", t + ".json"), JSON.stringify(rows, null, 1));
    for (const r of rows) sql.write(`insert into public."${t}" (${Object.keys(r).map((k) => `"${k}"`).join(", ")}) values (${Object.values(r).map(lit).join(", ")});\n`);
    total += rows.length;
    log(`  ${t}: ${rows.length} rows`);
  }
  await new Promise((r) => sql.end(r));
  await db.end();
  log(`Database: ${tables.length} tables, ${total} rows`);
}

async function files() {
  if (!cfg.SERVICE_ROLE_KEY) { log("Files: skipped (no SERVICE_ROLE_KEY in settings.txt)"); return; }
  const H = { apikey: cfg.SERVICE_ROLE_KEY, Authorization: "Bearer " + cfg.SERVICE_ROLE_KEY };
  const api = (p, o = {}) => fetch(cfg.SUPABASE_URL + "/storage/v1" + p, { ...o, headers: { ...H, "Content-Type": "application/json", ...(o.headers || {}) } });
  const buckets = await (await api("/bucket")).json();
  let n = 0, skipped = 0;
  for (const b of buckets) {
    const walk = async (prefix) => {
      for (let offset = 0; ; offset += 1000) {
        const list = await (await api(`/object/list/${b.id}`, { method: "POST", body: JSON.stringify({ prefix, limit: 1000, offset }) })).json();
        if (!Array.isArray(list) || !list.length) return;
        for (const o of list) {
          const key = prefix ? `${prefix}/${o.name}` : o.name;
          if (!o.id) { await walk(key); continue; } // a folder
          const dest = path.join(out, "files", b.id, ...key.split("/"));
          if (fs.existsSync(dest)) { skipped++; continue; }
          const res = await fetch(`${cfg.SUPABASE_URL}/storage/v1/object/${b.id}/${key.split("/").map(encodeURIComponent).join("/")}`, { headers: H });
          if (!res.ok) { log(`  could not download ${b.id}/${key}: ${res.status}`); continue; }
          fs.mkdirSync(path.dirname(dest), { recursive: true });
          fs.writeFileSync(dest, Buffer.from(await res.arrayBuffer()));
          n++;
        }
        if (list.length < 1000) return;
      }
    };
    await walk("");
  }
  log(`Files: ${n} downloaded${skipped ? `, ${skipped} already there` : ""}`);
}

function cleanUp() {
  const keep = Number(cfg.KEEP_DAYS || 60), root = cfg.BACKUP_FOLDER || "backup";
  const days = fs.readdirSync(root).filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d)).sort();
  for (const d of days.slice(0, Math.max(0, days.length - keep))) { fs.rmSync(path.join(root, d), { recursive: true, force: true }); log(`Old backup removed: ${d}`); }
}

try {
  log(`EMON OVERRUNS backup ${new Date().toString()} → ${out}`);
  await database();
  await files();
  cleanUp();
  log("BACKUP DONE");
} catch (e) {
  log("BACKUP FAILED: " + e.message);
  process.exit(1);
}

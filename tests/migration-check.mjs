// Verify that the SQL migration chain in ./drizzle produces exactly the same
// schema as `drizzle-kit push` (i.e. src/db/schema.ts).
//
//   DATABASE_URL=postgres://... node tests/migration-check.mjs
//
// Why a temp schema: `drizzle-kit migrate` cannot take --url, and we must not
// touch the application's public schema. We replay every migration inside a
// throwaway `migrate_check` schema, then diff information_schema.columns against
// `public` (created by drizzle-kit push in CI).
//
// This catches the exact bug that shipped in PR #9: schema.ts gained columns but
// no migration was generated, so a user applying migrations would end up with a
// database that is missing them.
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import pg from "pg";

const url = process.env.DATABASE_URL;
if (!url) {
  console.error("DATABASE_URL is required");
  process.exit(1);
}

const SCHEMA = "migrate_check";
const dir = path.join(process.cwd(), "drizzle");

/**
 * Strip type casts, schema qualification and whitespace so equivalent defaults
 * compare equal:
 *   '[]'::jsonb                    → '[]'
 *   nextval('public.x_id_seq')     → nextval('x_id_seq')
 *   nextval('migrate_check.x_id_seq') → nextval('x_id_seq')
 *
 * The schema qualifier differs only because we replay the migrations into a
 * throwaway schema; it is not real drift.
 */
function normDefault(v) {
  if (v == null) return "";
  return String(v)
    .replace(/::[a-z_ ]+( with(out)? time zone)?/gi, "")
    .replace(/nextval\('([a-z0-9_]+)\./gi, "nextval('")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

function key(r) {
  return `${r.table_name}.${r.column_name}`;
}

function fingerprint(r) {
  return `${r.data_type}|${r.is_nullable}|${normDefault(r.column_default)}`;
}

const client = new pg.Client({ connectionString: url });
await client.connect();
let ok = true;
try {
  const files = (await readdir(dir)).filter((f) => f.endsWith(".sql")).sort();
  if (!files.length) throw new Error("no .sql migrations found in ./drizzle");

  await client.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
  await client.query(`CREATE SCHEMA ${SCHEMA}`);
  await client.query(`SET search_path TO ${SCHEMA}`);

  for (const f of files) {
    const sql = await readFile(path.join(dir, f), "utf8");
    const statements = sql.split("--> statement-breakpoint").map((s) => s.trim()).filter(Boolean);
    for (const s of statements) await client.query(s);
    console.log(`applied ${f} (${statements.length} statements)`);
  }

  const cols = async (schema) => {
    const { rows } = await client.query(
      `select table_name, column_name, data_type, is_nullable, column_default
         from information_schema.columns
        where table_schema = $1
        order by table_name, column_name`,
      [schema],
    );
    return rows;
  };

  const publicRows = await cols("public");
  const migratedRows = await cols(SCHEMA);

  if (!publicRows.length) {
    throw new Error("public schema has no tables — run `drizzle-kit push` first");
  }

  const pub = new Map(publicRows.map((r) => [key(r), fingerprint(r)]));
  const mig = new Map(migratedRows.map((r) => [key(r), fingerprint(r)]));

  const missing = [...pub.keys()].filter((k) => !mig.has(k));
  const extra = [...mig.keys()].filter((k) => !pub.has(k));
  const changed = [...pub.keys()].filter((k) => mig.has(k) && mig.get(k) !== pub.get(k));

  if (missing.length || extra.length || changed.length) {
    ok = false;
    console.error("\nMIGRATION DRIFT");
    for (const k of missing) console.error(`  missing in migrations: ${k} (${pub.get(k)})`);
    for (const k of extra) console.error(`  extra in migrations:   ${k} (${mig.get(k)})`);
    for (const k of changed) console.error(`  differs: ${k}\n    public:   ${pub.get(k)}\n    migrated: ${mig.get(k)}`);
  } else {
    console.log(`schema parity OK: ${pub.size} columns across ${new Set(publicRows.map((r) => r.table_name)).size} tables`);
  }

  // The specific column this phase is about must exist after the chain.
  const hasRefs = migratedRows.some((r) => r.table_name === "assessment_findings" && r.column_name === "descriptor_refs");
  if (!hasRefs) {
    ok = false;
    console.error("assessment_findings.descriptor_refs is missing after migrations");
  } else {
    console.log("assessment_findings.descriptor_refs present after migrations");
  }
} finally {
  await client.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`).catch(() => {});
  await client.end().catch(() => {});
}

process.exit(ok ? 0 : 1);

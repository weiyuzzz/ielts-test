// Start a local embedded PostgreSQL for the IELTS platform.
// Keeps the process alive so the DB stays up for the Next.js app.
import EmbeddedPostgres from 'embedded-postgres';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, '..');
const databaseDir = path.join(projectRoot, '.pgdata');

const DB_USER = 'postgres';
const DB_PASSWORD = 'postgres';
const DB_PORT = 5432;
const DB_NAME = 'ielts_platform';

const pg = new EmbeddedPostgres({
  databaseDir,
  user: DB_USER,
  password: DB_PASSWORD,
  port: DB_PORT,
  persistent: true,
});

const needsInit = !fs.existsSync(path.join(databaseDir, 'PG_VERSION'));

if (needsInit) {
  console.log('[pg] Initialising new cluster at', databaseDir);
  await pg.initialise();
} else {
  console.log('[pg] Reusing existing cluster at', databaseDir);
}

await pg.start();
console.log(`[pg] PostgreSQL listening on 127.0.0.1:${DB_PORT}`);

// Ensure the application database exists.
try {
  await pg.createDatabase(DB_NAME);
  console.log(`[pg] Database "${DB_NAME}" ready`);
} catch (err) {
  // createDatabase throws if it already exists; that's fine.
  if (String(err?.message ?? err).includes('already exists')) {
    console.log(`[pg] Database "${DB_NAME}" already exists`);
  } else {
    throw err;
  }
}

const shutdown = async () => {
  console.log('[pg] Stopping PostgreSQL...');
  try { await pg.stop(); } catch (_) {}
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

// Keep the event loop alive.
setInterval(() => {}, 1 << 30);

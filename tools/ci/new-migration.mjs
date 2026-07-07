// Wave 2 · 2.3 — migration scaffolder + consistency analyzer.
// Root cause of the 2026-07-03 outage class: migrations are hand-numbered + hand-journaled, so two open PRs
// grab the same next number / a non-monotonic `when`, and one silently wins on merge (or is skipped in prod).
// The `migrations-journaled` CI gate catches this AFTER the fact; this tool prevents it BEFORE — it computes
// the correct next number / idx / when from the live tree, and (with --create) scaffolds the .sql stub AND
// the journal entry together so they can't drift.
//
//   node tools/ci/new-migration.mjs                 # dry-run: print the next free number / idx / when
//   node tools/ci/new-migration.mjs --create <slug> # create apps/api/drizzle/NNNN_<slug>.sql + journal entry
//
// The pure analyzer is exported so the ToE (cutover/migration-tooling) can assert its invariants.
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const DRIZZLE_DIR = 'apps/api/drizzle';
// Pre-existing historical duplicates, grandfathered by the migrations-journaled gate (CLAUDE.md).
const GRANDFATHERED_DUP_NUMS = new Set([85, 88, 104, 105]);

export function readMigrations(dir = DRIZZLE_DIR) {
  const sqlFiles = readdirSync(dir).filter((f) => /^\d{4}_.*\.sql$/.test(f)).sort();
  const journal = JSON.parse(readFileSync(join(dir, 'meta/_journal.json'), 'utf8'));
  return { sqlFiles, journal };
}

// Pure — takes { sqlFiles, journal } and returns the next free values + any consistency errors.
export function analyzeMigrations({ sqlFiles, journal }) {
  const errors = [];
  const nums = sqlFiles.map((f) => parseInt(f.slice(0, 4), 10));
  const tagsFromSql = sqlFiles.map((f) => f.replace(/\.sql$/, ''));
  const entries = journal.entries ?? [];
  const idxs = entries.map((e) => e.idx);
  const whens = entries.map((e) => e.when);
  const journalTags = entries.map((e) => e.tag);

  // Duplicate migration numbers (excluding grandfathered).
  const numSeen = new Map();
  for (const n of nums) numSeen.set(n, (numSeen.get(n) ?? 0) + 1);
  for (const [n, c] of numSeen) if (c > 1 && !GRANDFATHERED_DUP_NUMS.has(n)) errors.push(`duplicate migration number ${String(n).padStart(4, '0')} (${c}×)`);

  // Duplicate journal idx / tag.
  const idxSeen = new Set(); for (const i of idxs) { if (idxSeen.has(i)) errors.push(`duplicate journal idx ${i}`); idxSeen.add(i); }
  const tagSeen = new Set(); for (const t of journalTags) { if (tagSeen.has(t)) errors.push(`duplicate journal tag ${t}`); tagSeen.add(t); }

  // Every .sql has a journal entry and vice-versa.
  const journalTagSet = new Set(journalTags);
  for (const t of tagsFromSql) if (!journalTagSet.has(t)) errors.push(`migration ${t}.sql has no journal entry`);
  const sqlTagSet = new Set(tagsFromSql);
  for (const t of journalTags) if (!sqlTagSet.has(t)) errors.push(`journal entry '${t}' has no matching .sql`);

  const nextNum = (nums.length ? Math.max(...nums) : -1) + 1;
  const nextIdx = (idxs.length ? Math.max(...idxs) : -1) + 1;
  const nextWhen = (whens.length ? Math.max(...whens) : 0) + 1;
  return { nextNum, nextNumStr: String(nextNum).padStart(4, '0'), nextIdx, nextWhen, count: sqlFiles.length, errors };
}

export function computeNextMigration(dir = DRIZZLE_DIR) {
  return analyzeMigrations(readMigrations(dir));
}

function createMigration(dir, slug) {
  if (!/^[a-z0-9_]+$/.test(slug)) { console.error(`slug must be [a-z0-9_]: got '${slug}'`); process.exit(1); }
  const { sqlFiles, journal } = readMigrations(dir);
  const n = analyzeMigrations({ sqlFiles, journal });
  if (n.errors.length) { console.error('Refusing to scaffold — journal is inconsistent:\n  ' + n.errors.join('\n  ')); process.exit(1); }
  const tag = `${n.nextNumStr}_${slug}`;
  const sqlPath = join(dir, `${tag}.sql`);
  writeFileSync(sqlPath, `-- ${tag}\n-- TODO: describe the change. For a NEW tenant-scoped table, hand-append the 0232-form RLS loop\n-- and GRANT app_user (see CLAUDE.md). Keep statements idempotent (IF NOT EXISTS) where sensible.\n`);
  journal.entries.push({ idx: n.nextIdx, version: journal.entries.at(-1)?.version ?? '7', when: n.nextWhen, tag, breakpoints: true });
  writeFileSync(join(dir, 'meta/_journal.json'), JSON.stringify(journal, null, 2) + '\n');
  console.log(`✓ created ${sqlPath}\n✓ journaled idx=${n.nextIdx} when=${n.nextWhen} tag=${tag}`);
}

// CLI
if (import.meta.url === `file://${process.argv[1]}`) {
  const createFlag = process.argv.indexOf('--create');
  if (createFlag !== -1) {
    createMigration(DRIZZLE_DIR, process.argv[createFlag + 1] ?? '');
  } else {
    const n = computeNextMigration();
    if (n.errors.length) { console.error(`✗ journal inconsistent:\n  ${n.errors.join('\n  ')}`); process.exit(1); }
    console.log(`next migration: ${n.nextNumStr}  ·  idx ${n.nextIdx}  ·  when ${n.nextWhen}  (${n.count} migrations, journal consistent)`);
  }
}

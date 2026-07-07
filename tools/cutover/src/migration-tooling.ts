/**
 * Wave 2 · 2.3 — migration scaffolder/analyzer ToE (pure).
 * Verifies analyzeMigrations: the LIVE drizzle tree computes a strictly-greater next number/idx/when and is
 * consistent, and synthetic broken journals (dup number, orphan sql/journal, dup idx) are detected — the
 * class of error that caused the 2026-07-03 outage.
 *   NODE_OPTIONS=--experimental-sqlite pnpm --filter @ierp/cutover migration-tooling
 */
import { resolve } from 'node:path';
import { analyzeMigrations, computeNextMigration, readMigrations } from '../../ci/new-migration.mjs';

const checks: { name: string; ok: boolean; detail?: string }[] = [];
const ok = (name: string, cond: boolean, detail = '') => checks.push({ name, ok: cond, detail });
// Harness cwd is tools/cutover → resolve to the repo's drizzle dir (same convention as the other harnesses).
const DRIZZLE = resolve(process.cwd(), '../../apps/api/drizzle');

async function main() {
  // ── live tree ──
  const { sqlFiles, journal } = readMigrations(DRIZZLE);
  const live = computeNextMigration(DRIZZLE);
  const nums = sqlFiles.map((f: string) => parseInt(f.slice(0, 4), 10));
  const whens = (journal.entries ?? []).map((e: any) => e.when);
  const idxs = (journal.entries ?? []).map((e: any) => e.idx);
  ok('live: journal is consistent (no errors)', live.errors.length === 0, live.errors.join('; '));
  ok('live: next number > every existing number', live.nextNum > Math.max(...nums), `${live.nextNum} vs max ${Math.max(...nums)}`);
  ok('live: next when > every existing when (monotonic)', live.nextWhen > Math.max(...whens));
  ok('live: next idx > every existing idx', live.nextIdx > Math.max(...idxs));
  ok('live: next number is 4-digit zero-padded', /^\d{4}$/.test(live.nextNumStr));

  // ── synthetic: happy path ──
  const good = analyzeMigrations({ sqlFiles: ['0001_a.sql', '0002_b.sql'], journal: { entries: [{ idx: 0, tag: '0001_a', when: 1 }, { idx: 1, tag: '0002_b', when: 2 }] } });
  ok('synthetic clean → no errors, next 0003', good.errors.length === 0 && good.nextNumStr === '0003' && good.nextIdx === 2 && good.nextWhen === 3);

  // ── synthetic: the outage class ──
  const dupNum = analyzeMigrations({ sqlFiles: ['0005_a.sql', '0005_b.sql'], journal: { entries: [{ idx: 0, tag: '0005_a', when: 1 }, { idx: 1, tag: '0005_b', when: 2 }] } });
  ok('duplicate migration number → error', dupNum.errors.some((e: string) => /duplicate migration number 0005/.test(e)));
  const grand = analyzeMigrations({ sqlFiles: ['0085_a.sql', '0085_b.sql'], journal: { entries: [{ idx: 0, tag: '0085_a', when: 1 }, { idx: 1, tag: '0085_b', when: 2 }] } });
  ok('grandfathered dup number 0085 → NOT an error', !grand.errors.some((e: string) => /duplicate migration number/.test(e)));
  const orphanSql = analyzeMigrations({ sqlFiles: ['0001_a.sql'], journal: { entries: [] } });
  ok('sql without journal entry → error', orphanSql.errors.some((e: string) => /has no journal entry/.test(e)));
  const orphanJournal = analyzeMigrations({ sqlFiles: [], journal: { entries: [{ idx: 0, tag: '0001_a', when: 1 }] } });
  ok('journal entry without sql → error', orphanJournal.errors.some((e: string) => /no matching \.sql/.test(e)));
  const dupIdx = analyzeMigrations({ sqlFiles: ['0001_a.sql', '0002_b.sql'], journal: { entries: [{ idx: 5, tag: '0001_a', when: 1 }, { idx: 5, tag: '0002_b', when: 2 }] } });
  ok('duplicate journal idx → error', dupIdx.errors.some((e: string) => /duplicate journal idx 5/.test(e)));

  console.log('\n── Wave 2 · 2.3 — migration scaffolder/analyzer (cutover) ──');
  for (const c of checks) console.log(`  ${c.ok ? '✅' : '❌'} ${c.name}${c.detail ? `  (${c.detail})` : ''}`);
  const failed = checks.filter((c) => !c.ok).length;
  console.log(failed ? `\n❌ ${failed}/${checks.length} migration-tooling checks failed` : `\n✅ All ${checks.length} migration-tooling checks passed`);
  process.exit(failed ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });

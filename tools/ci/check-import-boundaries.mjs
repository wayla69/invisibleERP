// Ledger import-boundary ratchet — docs/46 Phase 3.
// The GL's journal tables are the ledger module's OWN: other modules read balances / entry refs through the
// narrow LedgerReadService API (modules/ledger/ledger-read.service.ts) or the LedgerService facade, and post
// only via LedgerService.postEntry (GL-05). Because the flat schema barrel lets any module import any
// domain's tables, this guard RATCHETS the boundary instead of breaking the barrel: every file outside
// modules/ledger/ that references the journalEntries/journalLines Drizzle tables today is grandfathered in
// the committed baseline (ledger-boundary-baseline.json), and the SET may only SHRINK. A PR that adds a
// direct journal read in a new file fails; use LedgerReadService (accountNet/cashPosition/entryRefNo — or
// add an equally narrow method there) instead. When a migration removes a file's direct reads, drop it from
// the baseline in the same PR (the guard prints the list); --update regenerates.
//
// NB the detector is by-identifier, not by-import-path, so both `from '../../database/schema'` (the barrel)
// and `from '../../database/schema/ledger'` count — a rename dodge would still fail human review.
import { readFileSync, writeFileSync, readdirSync, statSync } from 'node:fs';
import { join, sep } from 'node:path';

const BASELINE_PATH = 'tools/ci/ledger-boundary-baseline.json';
const baseline = JSON.parse(readFileSync(BASELINE_PATH, 'utf8'));

// Paths are normalised to POSIX separators: the prefix filter below and the committed baseline both
// use forward slashes, but node:path join() emits '\' on Windows — without this the modules/ledger
// exclusion silently never matches there and the gate reports every ledger file as a new offender.
const files = [];
const walk = (dir) => {
  for (const f of readdirSync(dir)) {
    const p = join(dir, f);
    if (statSync(p).isDirectory()) walk(p);
    else if (f.endsWith('.ts') && !f.endsWith('.spec.ts') && !f.endsWith('.test.ts')) {
      files.push(p.split(sep).join('/'));
    }
  }
};
walk('apps/api/src');

const RE = /\b(journalEntries|journalLines)\b/;
const offenders = files
  .filter((f) => !f.startsWith('apps/api/src/modules/ledger/') && !f.startsWith('apps/api/src/database/schema/'))
  .filter((f) => RE.test(readFileSync(f, 'utf8')))
  .sort();

if (process.argv.includes('--update')) {
  writeFileSync(BASELINE_PATH, JSON.stringify({ _note: baseline._note, files: offenders }, null, 2) + '\n');
  console.log(`wrote ${BASELINE_PATH}: ${offenders.length} grandfathered files`);
  process.exit(0);
}

const allowed = new Set(baseline.files);
const added = offenders.filter((f) => !allowed.has(f));
const removed = baseline.files.filter((f) => !offenders.includes(f));

console.log(`ledger-boundary: ${offenders.length}/${baseline.files.length} files outside modules/ledger touch journalEntries/journalLines`);
if (added.length) {
  console.error('❌ ledger import-boundary ratchet failed (new direct GL-table access):');
  for (const f of added) console.error('  - ' + f);
  console.error('   Read GL state through the narrow LedgerReadService API (accountNet / cashPosition /');
  console.error('   entryRefNo — or add an equally narrow method there) and post via LedgerService.postEntry;');
  console.error(`   do not join journal_entries/journal_lines from another module. See docs/46 §4 Phase 3.`);
  process.exit(1);
}
if (removed.length) {
  console.log('ℹ️ boundary debt went DOWN — ratchet it in this PR (or run --update):');
  for (const f of removed) console.log('  - ' + f + ' no longer touches the journal tables');
}
console.log('✅ no new direct GL-table access');

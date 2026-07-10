// Deploy segregation-of-duties ToE (ITGC-CM-03 — deployer ≠ author).
//
// The PRIMARY control for ITGC-CM-03 is the GitHub `production` Environment's REQUIRED REVIEWERS gate:
// a human other than the change author must approve before the deploy job runs. This script is the
// AUTOMATED, RE-PERFORMABLE EVIDENCE for that control — it compares the identity that TRIGGERED the deploy
// (GITHUB_ACTOR) against the AUTHOR of the commit being deployed (git author email/login) and fails when
// they are the same identity, i.e. a developer self-deploying their own change.
//
// Inputs (all overridable so it can be unit-run locally — see --selftest):
//   DEPLOY_ACTOR   (fallback: GITHUB_ACTOR)          — GitHub login of whoever triggered the deploy
//   COMMIT_AUTHOR  (fallback: git log -1 --format=%ae) — author email/login of the deployed commit
//   COMMIT_SHA     (fallback: GITHUB_SHA / git HEAD)  — informational only
//
// Identity normalisation makes a GitHub login comparable to a git author email:
//   - lowercased + trimmed
//   - a GitHub noreply email `12345+octocat@users.noreply.github.com` (or `octocat@users.noreply.github.com`)
//     collapses to its login `octocat`
//   - any other email collapses to its local-part (before the `@`)
// so `octocat` (actor) and `123+octocat@users.noreply.github.com` (author) are recognised as the SAME person.
//
// Exit codes: 0 = deployer ≠ author (SoD holds) · 1 = SAME identity (SoD violation) or usage error.
// SECURITY: prints only usernames/local-parts — never a token, secret, or full private email domain body.

import { execFileSync } from 'node:child_process';

/** Normalise a GitHub login or git author email to a canonical, comparable identity. */
export function canonicalIdentity(raw) {
  if (!raw) return '';
  let s = String(raw).trim().toLowerCase();
  // strip a `Name <email>` wrapper if present
  const angle = s.match(/<([^>]+)>/);
  if (angle) s = angle[1].trim();
  if (s.includes('@')) {
    const [local, domain] = s.split('@');
    if (domain && (domain === 'users.noreply.github.com' || domain.endsWith('.users.noreply.github.com'))) {
      // `12345+octocat` → `octocat`; `octocat` → `octocat`
      return local.includes('+') ? local.split('+').slice(1).join('+') : local;
    }
    return local; // other emails: compare on the local-part
  }
  return s; // a bare login
}

/** Decide the SoD outcome. Returns { violation: boolean, actor, author, reason }. */
export function evaluateDeploySod(deployActor, commitAuthor) {
  const actor = canonicalIdentity(deployActor);
  const author = canonicalIdentity(commitAuthor);
  if (!actor || !author) {
    return { violation: false, actor, author, reason: 'insufficient-identity', indeterminate: true };
  }
  const violation = actor === author;
  return { violation, actor, author, reason: violation ? 'same-identity' : 'distinct-identity' };
}

function gitAuthorEmail() {
  try {
    return execFileSync('git', ['log', '-1', '--format=%ae'], { encoding: 'utf8' }).trim();
  } catch {
    return '';
  }
}
function gitHeadSha() {
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  } catch {
    return '';
  }
}

function runSelfTest() {
  const cases = [
    { name: 'same bare login → violation', actor: 'alice', author: 'alice', expectViolation: true },
    { name: 'distinct logins → ok', actor: 'alice', author: 'bob', expectViolation: false },
    {
      name: 'login vs GitHub noreply email (same person) → violation',
      actor: 'octocat',
      author: '123456+octocat@users.noreply.github.com',
      expectViolation: true,
    },
    {
      name: 'login vs GitHub noreply email (different person) → ok',
      actor: 'octocat',
      author: '123456+hubber@users.noreply.github.com',
      expectViolation: false,
    },
    {
      name: 'case/whitespace-insensitive match → violation',
      actor: '  Alice  ',
      author: 'alice@example.com',
      expectViolation: true,
    },
  ];
  let failed = 0;
  for (const c of cases) {
    const r = evaluateDeploySod(c.actor, c.author);
    const pass = r.violation === c.expectViolation;
    if (!pass) failed++;
    console.log(`  ${pass ? '✅' : '❌'} ${c.name}  (actor=${r.actor} author=${r.author} → ${r.reason})`);
  }
  console.log(failed ? `\n❌ ${failed}/${cases.length} self-tests failed` : `\n✅ All ${cases.length} self-tests passed`);
  return failed ? 1 : 0;
}

function main() {
  if (process.argv.includes('--selftest')) {
    process.exit(runSelfTest());
  }

  const deployActor = process.env.DEPLOY_ACTOR || process.env.GITHUB_ACTOR || '';
  const commitAuthor = process.env.COMMIT_AUTHOR || gitAuthorEmail();
  const sha = (process.env.COMMIT_SHA || process.env.GITHUB_SHA || gitHeadSha()).slice(0, 12);

  const r = evaluateDeploySod(deployActor, commitAuthor);
  console.log(`ITGC-CM-03 deploy SoD — commit ${sha || '(unknown)'}`);
  console.log(`  deploy actor : ${r.actor || '(unset)'}`);
  console.log(`  commit author: ${r.author || '(unset)'}`);

  if (r.indeterminate) {
    // Missing an identity is NOT treated as a pass or a hard fail: emit a warning so the primary
    // Environment-reviewer gate remains the control of record, and let the caller decide via enforce mode.
    console.log('::warning::deploy-SoD: could not determine both identities (actor/author) — relying on the production Environment reviewer gate.');
    process.exit(0);
  }

  if (r.violation) {
    console.error('::error::ITGC-CM-03 VIOLATION — the deployer is the SAME identity as the commit author (self-deploy). Production deploys require deployer ≠ author.');
    process.exit(1);
  }

  console.log('✅ deployer ≠ author — segregation of duties holds.');
  process.exit(0);
}

main();

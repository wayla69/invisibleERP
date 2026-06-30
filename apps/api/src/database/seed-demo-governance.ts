/**
 * Demo entity-level governance for the Oshinei tenant — a live "first operating cycle" for the three ELC
 * controls so GET /api/governance/readiness shows a healthy, current cycle:
 *   ELC-01 code-of-conduct acknowledgements (for the tenant's active staff),
 *   ELC-02 a recent audit-committee ICFR meeting (signed off, not overdue),
 *   ELC-03 the delegation-of-authority matrix, ELC-05 the fraud-risk register (F1–F8),
 *   ELC-04 a sample resolved whistleblower case.
 * Deterministic + idempotent. Requires the demo tenant: `pnpm --filter @ierp/api db:seed:demo`
 * Run: `pnpm --filter @ierp/api db:seed:demo:governance`
 */
import { resolve } from 'node:path';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { eq, and, ne, sql } from 'drizzle-orm';
import * as schema from './schema';

for (const p of ['.env', resolve(process.cwd(), '../../.env')]) {
  try { (process as unknown as { loadEnvFile?: (path: string) => void }).loadEnvFile?.(p); } catch { /* ignore */ }
}

const POLICY_VERSION = '2026-1.0';
const ymd = (d: Date) => d.toISOString().slice(0, 10);

// ELC-03 — delegation-of-authority matrix (per compliance/policies/03, mapped to roles + maker-checker limits).
const DOA: [string, string, number | null][] = [
  ['Journal entry', 'FinancialController', null],
  ['AP payment', 'FinancialController', 500000],
  ['Purchase order', 'Procurement', 100000],
  ['Credit limit', 'FinancialController', 500000],
  ['Stocktake variance post', 'InventoryController', null],
];
// ELC-05 — fraud-risk register F1–F8 (per compliance/policies/05), each mapped to its mitigating RCM controls.
const FRAUD: [string, string, string, string, string][] = [
  ['F1', 'Revenue', 'Fictitious sales / unrecorded voids at POS', 'high', 'REV-13 void approval, Z-report, REC-05 cash banking'],
  ['F2', 'Expenditure', 'Fake vendor / duplicate invoice payment', 'high', 'EXP-01 three-way match, EXP-03 PO-approval GR gate, SoD R03'],
  ['F3', 'Payroll', 'Ghost employees / inflated hours', 'medium', 'PAY-03 maker-checker, HR roster review'],
  ['F4', 'GL', 'Management override via manual journal entry', 'high', 'GL-05 maker-checker (Draft+approve), GL-immutability'],
  ['F5', 'Inventory', 'Theft masked as a stocktake variance', 'medium', 'INV-04 variance-review maker-checker'],
  ['F6', 'Cash', 'Skimming / till misappropriation', 'medium', 'REC-05 cash banking, till-variance GL'],
  ['F7', 'Related parties', 'Undisclosed related-party transactions', 'medium', 'REC-03 IC reconciliation sign-off, consolidation'],
  ['F8', 'Access', 'Privilege misuse / SoD bypass', 'high', 'ITGC-AC-09 SoD block, AC-10 audit trail'],
];

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL not set');
  const client = postgres(url, { max: 1 });
  const db = drizzle(client, { schema });

  await db.transaction(async (tx) => {
    await tx.execute(sql`select set_config('app.bypass_rls', 'on', true)`);
    const tenant = (await tx.select().from(schema.tenants).where(eq(schema.tenants.code, 'OSHINEI')))[0];
    if (!tenant) throw new Error('OSHINEI tenant not found — run db:seed:demo first');
    const T = tenant.id;

    // ── wipe (idempotent, tenant-scoped) ──
    await tx.delete(schema.ethicsAcknowledgements).where(eq(schema.ethicsAcknowledgements.tenantId, T));
    await tx.delete(schema.governanceOversight).where(eq(schema.governanceOversight.tenantId, T));
    await tx.delete(schema.delegationOfAuthority).where(eq(schema.delegationOfAuthority.tenantId, T));
    await tx.delete(schema.fraudRisks).where(eq(schema.fraudRisks.tenantId, T));
    await tx.delete(schema.whistleblowerCases).where(eq(schema.whistleblowerCases.tenantId, T));

    // ── ELC-01: acknowledge the code of conduct for every active, non-customer staff user (→ coverage %). ──
    const staff = await tx.select().from(schema.users).where(and(eq(schema.users.tenantId, T), eq(schema.users.isActive, true), ne(schema.users.role, 'Customer')));
    if (staff.length) {
      await tx.insert(schema.ethicsAcknowledgements).values(staff.map((u) => ({ tenantId: T, username: u.username, policyVersion: POLICY_VERSION })));
    }

    // ── ELC-02: a recent audit-committee ICFR meeting (7 days ago → current, not overdue). ──
    const meeting = new Date(); meeting.setDate(meeting.getDate() - 7);
    await tx.insert(schema.governanceOversight).values({
      tenantId: T, meetingDate: ymd(meeting), kind: 'audit_committee',
      topics: 'Quarterly ICFR review: RCM exceptions, maker-checker backlog (GOV-01), whistleblower case summary',
      icfrReviewed: true, findingsReviewed: 'No significant deficiencies; 2 follow-ups tracked to next meeting',
      attendees: 'AC Chair, 2 members, CFO (by invitation)', minutesRef: 'AC-2026-Q3-MIN', signedOffBy: 'AC Chair', createdBy: 'demo-seed',
    });

    // ── ELC-03: delegation-of-authority matrix. ──
    await tx.insert(schema.delegationOfAuthority).values(DOA.map(([area, role, lim]) => ({
      tenantId: T, authorityArea: area, role, approvalLimit: lim != null ? String(lim) : null, currency: 'THB', notes: 'per DoA policy v1.0', effectiveFrom: '2026-07-01', createdBy: 'demo-seed',
    })));

    // ── ELC-05: fraud-risk register (F1–F8), reviewed + mitigated. ──
    await tx.insert(schema.fraudRisks).values(FRAUD.map(([ref, area, desc, lk, ctrl]) => ({
      tenantId: T, riskRef: `FR-OSH-${ref}`, area, description: desc, likelihood: lk, impact: 'high', mitigatingControls: ctrl, owner: 'Compliance', status: 'mitigated', lastReviewedAt: new Date(), createdBy: 'demo-seed',
    })));

    // ── ELC-04: a sample resolved whistleblower case (anonymous, within SLA). ──
    await tx.insert(schema.whistleblowerCases).values({
      tenantId: T, caseRef: 'WB-OSHDEMO1', category: 'conduct', allegation: 'Concern raised about overtime-hours recording accuracy',
      reporter: null, anonymous: true, status: 'resolved', resolutionNote: 'Investigated; the timesheet process was clarified with the kitchen team; no misconduct found', handledBy: 'compliance',
      submittedAt: new Date(Date.now() - 20 * 86400000),
    });
  });

  await client.end();
  console.log('✅ Seeded ELC governance first cycle for OSHINEI (acknowledgements, oversight meeting, DoA, fraud register, sample case)');
}
main().catch((e) => { console.error(e); process.exit(1); });

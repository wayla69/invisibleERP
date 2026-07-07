/**
 * Wave 2 · 5.1a — VAT tax-point resolver ToE (pure; INERT scaffolding).
 * Verifies resolveTaxPoint against ประมวลรัษฎากร ม.78 (goods) / ม.78/1 (services) and
 * resolveInstallmentTaxPoints against ม.78(2). No DB — pure rule matrix.
 *   NODE_OPTIONS=--experimental-sqlite pnpm --filter @ierp/cutover tax-point
 */
import { resolveTaxPoint, resolveInstallmentTaxPoints } from '../../../apps/api/dist/modules/tax/tax-point';

const checks: { name: string; ok: boolean; detail?: string }[] = [];
const ok = (name: string, cond: boolean, detail = '') => checks.push({ name, ok: cond, detail });

async function main() {
  // ── Goods (ม.78): earliest of delivery / transfer / payment / invoice ──
  ok('goods: delivery (06-10) before invoice (06-15) → tax point 06-10',
    resolveTaxPoint({ supplyType: 'goods', invoiceDate: '2026-06-15', deliveryDate: '2026-06-10' }) === '2026-06-10');
  ok('goods: payment (06-05) earliest → 06-05 (paid before delivery/invoice)',
    resolveTaxPoint({ supplyType: 'goods', invoiceDate: '2026-06-15', deliveryDate: '2026-06-10', paymentDate: '2026-06-05' }) === '2026-06-05');
  ok('goods: transfer-of-ownership (06-08) earliest → 06-08',
    resolveTaxPoint({ supplyType: 'goods', invoiceDate: '2026-06-15', deliveryDate: '2026-06-12', transferDate: '2026-06-08' }) === '2026-06-08');
  ok('goods: no earlier event → invoice date (default is delivery, but only invoice known here)',
    resolveTaxPoint({ supplyType: 'goods', invoiceDate: '2026-06-15' }) === '2026-06-15');
  ok('goods: deposit/advance paid (06-01) before delivery → tax point at receipt 06-01',
    resolveTaxPoint({ supplyType: 'goods', invoiceDate: '2026-06-20', deliveryDate: '2026-06-18', paymentDate: '2026-06-01' }) === '2026-06-01');

  // ── Services (ม.78/1): earliest of payment / invoice / service-used ──
  ok('service: payment (06-12) before invoice (06-20) → 06-12',
    resolveTaxPoint({ supplyType: 'service', invoiceDate: '2026-06-20', paymentDate: '2026-06-12' }) === '2026-06-12');
  ok('service: invoice (06-18) before payment (06-25) → 06-18',
    resolveTaxPoint({ supplyType: 'service', invoiceDate: '2026-06-18', paymentDate: '2026-06-25' }) === '2026-06-18');
  ok('service: service-used (06-14) earliest → 06-14',
    resolveTaxPoint({ supplyType: 'service', invoiceDate: '2026-06-20', paymentDate: '2026-06-25', serviceUsedDate: '2026-06-14' }) === '2026-06-14');
  ok('service: only invoice known → invoice date',
    resolveTaxPoint({ supplyType: 'service', invoiceDate: '2026-06-20' }) === '2026-06-20');
  ok('service: delivery/transfer are IGNORED for services (not in the ม.78/1 set)',
    resolveTaxPoint({ supplyType: 'service', invoiceDate: '2026-06-20', deliveryDate: '2026-06-01' as any } as any) === '2026-06-20');

  // ── null/empty handling ──
  ok('null events are ignored; invoice always a candidate',
    resolveTaxPoint({ supplyType: 'goods', invoiceDate: '2026-06-15', deliveryDate: null, paymentDate: undefined, transferDate: '' }) === '2026-06-15');

  // ── Installments (ม.78(2)): per-instalment due dates, ordered ──
  ok('installments: due dates returned in chronological order',
    JSON.stringify(resolveInstallmentTaxPoints(['2026-08-01', '2026-06-01', '2026-07-01'])) === JSON.stringify(['2026-06-01', '2026-07-01', '2026-08-01']));
  ok('installments: nulls filtered out',
    JSON.stringify(resolveInstallmentTaxPoints(['2026-06-01', null, '', '2026-07-01'])) === JSON.stringify(['2026-06-01', '2026-07-01']));

  console.log('\n── Wave 2 · 5.1a — VAT tax-point resolver (cutover) ──');
  for (const c of checks) console.log(`  ${c.ok ? '✅' : '❌'} ${c.name}${c.detail ? `  (${c.detail})` : ''}`);
  const failed = checks.filter((c) => !c.ok).length;
  console.log(failed ? `\n❌ ${failed}/${checks.length} tax-point checks failed` : `\n✅ All ${checks.length} tax-point checks passed`);
  process.exit(failed ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });

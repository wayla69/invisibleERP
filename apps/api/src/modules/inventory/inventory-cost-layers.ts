import { BadRequestException } from '@nestjs/common';
import { and, asc, eq, sql } from 'drizzle-orm';
import type { DrizzleDb } from '../../database/database.module';
import { invCostLayers } from '../../database/schema';
import { n } from '../../database/queries';

// FIFO/FEFO cost-layer helpers (0131), extracted from inventory-ledger.service.ts (docs/46-style shrink —
// the service dropped under the 600-LOC god-service line). Pure db-first functions, same pattern as
// billing/tenant-wipe.ts: the service passes its DrizzleDb, no DI of its own.

export const round4 = (x: number): number => Math.round((Number(x) || 0) * 10000) / 10000;
export const EPS = 1e-6;

export const COSTING_METHODS = ['moving_avg', 'fifo', 'fefo'] as const;
export type CostingMethod = (typeof COSTING_METHODS)[number];
export const isLayered = (m?: string | null): boolean => m === 'fifo' || m === 'fefo';

export interface LayerSlice { qty: number; unitCost: number; lotNo: string | null; expiry: string | null }

export async function createLayer(
  db: DrizzleDb, tenantId: number, itemId: string, loc: string, qty: number, unitCost: number,
  lotNo: string | null, expiry: string | null, refType: string | null, refId: string | null, by: string,
): Promise<void> {
  if (!(qty > EPS)) return;
  await db.insert(invCostLayers).values({
    tenantId, itemId, locationId: loc, lotNo: lotNo ?? null, expiryDate: expiry ?? null,
    origQty: String(qty), remainingQty: String(qty), unitCost: String(unitCost),
    refType: refType ?? null, refId: refId ?? null, createdBy: by,
  });
}

// Consume `qty` from a fifo/fefo item's open layers in cost order; mutates remaining_qty and returns the
// actual cost consumed + the per-layer slices (so a transfer can recreate them at the destination).
export async function consumeLayers(
  db: DrizzleDb, tenantId: number, itemId: string, loc: string, qty: number, method: CostingMethod,
): Promise<{ cost: number; slices: LayerSlice[] }> {
  const order = method === 'fefo'
    ? [sql`${invCostLayers.expiryDate} asc nulls last`, asc(invCostLayers.id)]
    : [asc(invCostLayers.id)]; // fifo = oldest receipt first (id is monotonic)
  const layers = await db.select().from(invCostLayers)
    .where(and(eq(invCostLayers.tenantId, tenantId), eq(invCostLayers.itemId, itemId), eq(invCostLayers.locationId, loc), sql`${invCostLayers.remainingQty} > 0`))
    .orderBy(...order);
  let remaining = round4(qty), cost = 0;
  const slices: LayerSlice[] = [];
  for (const l of layers) {
    if (remaining <= EPS) break;
    const take = Math.min(n(l.remainingQty), remaining);
    cost = round4(cost + take * n(l.unitCost));
    slices.push({ qty: round4(take), unitCost: n(l.unitCost), lotNo: l.lotNo ?? null, expiry: l.expiryDate ?? null });
    await db.update(invCostLayers).set({ remainingQty: String(round4(n(l.remainingQty) - take)) }).where(eq(invCostLayers.id, l.id));
    remaining = round4(remaining - take);
  }
  if (remaining > EPS)
    throw new BadRequestException({ code: 'LAYER_SHORT', message: `Insufficient cost layers for ${itemId} (${remaining} uncosted)`, messageTh: 'ชั้นต้นทุนไม่พอสำหรับการเบิก' });
  return { cost, slices };
}

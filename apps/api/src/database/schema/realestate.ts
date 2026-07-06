import { pgTable, bigserial, bigint, text, numeric, integer, date, timestamp, index, unique } from 'drizzle-orm/pg-core';
import { tenants } from './tenants';

// Real-estate developer vertical (docs/35 Track D / P4, RE-01/02/03). A developer sells units to buyers: a
// development (re_projects) holds units (re_units); a buyer books a unit (re_bookings → reserved) and the
// booking becomes a sale contract (re_contracts, maker-checker on price/discount → RE-02) with an installment
// plan (re_installments). Cash received before transfer is a contract liability (2410) / deposit (2210);
// revenue recognises at transfer (P5). Permission-gated (re_sales) so a non-property tenant never sees it.
export const reProjects = pgTable(
  're_projects',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    tenantId: bigint('tenant_id', { mode: 'number' }).references(() => tenants.id),
    devCode: text('dev_code').notNull(),
    name: text('name').notNull(),
    location: text('location'),
    status: text('status').notNull().default('active'),      // active | closed
    createdBy: text('created_by'),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow(),
  },
  (t) => ({ byTenant: index('idx_redev_tenant').on(t.tenantId, t.status), byCode: unique('idx_redev_code').on(t.devCode) }),
);

export const reUnits = pgTable(
  're_units',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    tenantId: bigint('tenant_id', { mode: 'number' }).references(() => tenants.id),
    reProjectId: bigint('re_project_id', { mode: 'number' }).notNull().references(() => reProjects.id),
    unitNo: text('unit_no').notNull(),
    unitType: text('unit_type').notNull().default('condo'),  // condo | house | land | other
    areaSqm: numeric('area_sqm', { precision: 12, scale: 2 }).notNull().default('0'),
    floor: text('floor'),
    listPrice: numeric('list_price', { precision: 16, scale: 2 }).notNull().default('0'),
    cost: numeric('cost', { precision: 16, scale: 2 }).notNull().default('0'),  // construction cost (relieved at transfer, RE-04)
    status: text('status').notNull().default('available'),   // available | reserved | contracted | transferred
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow(),
  },
  (t) => ({ byDev: index('idx_reunit_dev').on(t.reProjectId), byTenant: index('idx_reunit_tenant').on(t.tenantId, t.reProjectId), byNo: unique('idx_reunit_no').on(t.reProjectId, t.unitNo) }),
);

export const reBookings = pgTable(
  're_bookings',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    tenantId: bigint('tenant_id', { mode: 'number' }).references(() => tenants.id),
    unitId: bigint('unit_id', { mode: 'number' }).notNull().references(() => reUnits.id),
    bookingNo: text('booking_no').notNull(),
    buyerName: text('buyer_name'),
    deposit: numeric('deposit', { precision: 16, scale: 2 }).notNull().default('0'),
    status: text('status').notNull().default('held'),        // held | converted | cancelled
    expiresOn: date('expires_on'),
    entryNo: text('entry_no'),
    createdBy: text('created_by'),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow(),
  },
  (t) => ({ byUnit: index('idx_rebooking_unit').on(t.unitId), byTenant: index('idx_rebooking_tenant').on(t.tenantId, t.status), byNo: unique('idx_rebooking_no').on(t.bookingNo) }),
);

export const reContracts = pgTable(
  're_contracts',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    tenantId: bigint('tenant_id', { mode: 'number' }).references(() => tenants.id),
    unitId: bigint('unit_id', { mode: 'number' }).notNull().references(() => reUnits.id),
    bookingId: bigint('booking_id', { mode: 'number' }),
    contractNo: text('contract_no').notNull(),
    buyerName: text('buyer_name'),
    listPrice: numeric('list_price', { precision: 16, scale: 2 }).notNull().default('0'),
    discount: numeric('discount', { precision: 16, scale: 2 }).notNull().default('0'),
    price: numeric('price', { precision: 16, scale: 2 }).notNull().default('0'),
    downPayment: numeric('down_payment', { precision: 16, scale: 2 }).notNull().default('0'),
    balance: numeric('balance', { precision: 16, scale: 2 }).notNull().default('0'),
    installmentCount: integer('installment_count').notNull().default(0),
    status: text('status').notNull().default('draft'),       // draft | active | transferred | cancelled
    entryNo: text('entry_no'),
    createdBy: text('created_by'),
    approvedBy: text('approved_by'),                         // checker — must differ from created_by (SoD)
    approvedAt: timestamp('approved_at', { withTimezone: true }),
    transferEntryNo: text('transfer_entry_no'),              // the revenue-recognition JE at ownership transfer (RE-04)
    transferredAt: timestamp('transferred_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow(),
  },
  (t) => ({ byUnit: index('idx_recontract_unit').on(t.unitId), byTenant: index('idx_recontract_tenant').on(t.tenantId, t.status), byNo: unique('idx_recontract_no').on(t.contractNo) }),
);

export const reInstallments = pgTable(
  're_installments',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    tenantId: bigint('tenant_id', { mode: 'number' }).references(() => tenants.id),
    contractId: bigint('contract_id', { mode: 'number' }).notNull().references(() => reContracts.id),
    seq: integer('seq').notNull().default(1),
    dueDate: date('due_date'),
    amount: numeric('amount', { precision: 16, scale: 2 }).notNull().default('0'),
    paidAmount: numeric('paid_amount', { precision: 16, scale: 2 }).notNull().default('0'),
    status: text('status').notNull().default('pending'),     // pending | paid
    paidAt: timestamp('paid_at', { withTimezone: true }),
    entryNo: text('entry_no'),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
  },
  (t) => ({ byContract: index('idx_reinstall_contract').on(t.contractId), byTenant: index('idx_reinstall_tenant').on(t.tenantId, t.status, t.dueDate) }),
);

export type ReProject = typeof reProjects.$inferSelect;
export type ReUnit = typeof reUnits.$inferSelect;
export type ReBooking = typeof reBookings.$inferSelect;
export type ReContract = typeof reContracts.$inferSelect;
export type ReInstallment = typeof reInstallments.$inferSelect;

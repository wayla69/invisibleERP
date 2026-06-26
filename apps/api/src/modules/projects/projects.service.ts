import { Inject, Injectable, BadRequestException, NotFoundException } from '@nestjs/common';
import { eq, desc, sql } from 'drizzle-orm';
import { DRIZZLE, type DrizzleDb } from '../../database/database.module';
import { projects, projectEntries } from '../../database/schema';
import { LedgerService } from '../ledger/ledger.service';
import { ymd, n, fx } from '../../database/queries';
import type { JwtUser } from '../../common/decorators';

const r2 = (x: unknown) => Math.round((Number(x) || 0) * 100) / 100;

export interface CreateProjectDto { project_code?: string; name: string; customer_name?: string; billing_type?: 'TM' | 'Fixed'; budget_amount?: number; contract_amount?: number; start_date?: string; end_date?: string }
export interface CostDto { entry_type?: 'time' | 'expense'; description?: string; qty?: number; rate?: number; amount?: number; billable?: boolean; entry_date?: string }
export interface BillDto { amount: number }

@Injectable()
export class ProjectsService {
  constructor(
    @Inject(DRIZZLE) private readonly db: DrizzleDb,
    private readonly ledger: LedgerService,
  ) {}

  async create(dto: CreateProjectDto, user: JwtUser) {
    const db = this.db as any;
    const code = dto.project_code?.trim() || `PRJ${String(Date.now()).slice(-6)}`;
    await db.insert(projects).values({
      tenantId: user.tenantId ?? null, projectCode: code, name: dto.name, customerName: dto.customer_name ?? null,
      billingType: dto.billing_type ?? 'TM', budgetAmount: fx(dto.budget_amount ?? 0, 2), contractAmount: fx(dto.contract_amount ?? 0, 2),
      status: 'Open', startDate: dto.start_date ?? null, endDate: dto.end_date ?? null, createdBy: user.username,
    });
    return this.get(code);
  }

  // Log a cost (time/expense). A BILLABLE cost is a recoverable asset → capitalised in project WIP (Dr 1260
  // / Cr 2390) and relieved to COGS at billing. A NON-BILLABLE cost is unrecoverable, so it is EXPENSED
  // immediately to project COGS (Dr 5800 / Cr 2390) and never enters the billable WIP — you can't bill the
  // customer for it, and conservative accounting must not carry it as a recoverable asset.
  async logCost(code: string, dto: CostDto, user: JwtUser) {
    const db = this.db as any;
    const p = await this.row(code);
    const amount = r2(dto.amount != null ? n(dto.amount) : n(dto.qty) * n(dto.rate));
    if (amount <= 0) throw new BadRequestException({ code: 'BAD_AMOUNT', message: 'Cost amount must be positive', messageTh: 'จำนวนต้นทุนต้องมากกว่าศูนย์' });
    const tenantId = p.tenantId ?? user.tenantId ?? null;
    const billable = dto.billable !== false; // default true

    const [e] = await db.insert(projectEntries).values({
      projectId: Number(p.id), tenantId, entryType: dto.entry_type ?? 'time', description: dto.description ?? null,
      qty: fx(dto.qty ?? 0, 2), rate: fx(dto.rate ?? 0, 2), amount: fx(amount, 2), billable,
      entryDate: dto.entry_date ?? ymd(), createdBy: user.username,
    }).returning({ id: projectEntries.id });

    const conv = dto.entry_type === 'expense' ? 'Project expense' : 'Project labor';
    const je: any = await this.ledger.postEntry({
      source: 'PRJ-COST', sourceRef: `${code}:${Number(e.id)}`, tenantId, memo: `Project cost ${code}${billable ? '' : ' (non-billable)'}`, createdBy: user.username,
      lines: billable
        ? [{ account_code: '1260', debit: amount, memo: `WIP ${code}` }, { account_code: '2390', credit: amount, memo: conv }]
        : [{ account_code: '5800', debit: amount, memo: `Non-billable cost ${code}` }, { account_code: '2390', credit: amount, memo: conv }],
    });
    await db.update(projectEntries).set({ entryNo: je.entry_no }).where(eq(projectEntries.id, Number(e.id)));
    // Only billable costs accumulate in the recoverable WIP (cost_to_date); non-billable are already expensed.
    const costToDate = billable ? r2(n(p.costToDate) + amount) : n(p.costToDate);
    await db.update(projects).set({ costToDate: fx(costToDate, 2), status: p.status === 'Open' ? 'Active' : p.status }).where(eq(projects.id, Number(p.id)));
    return { project_code: code, entry_no: je.entry_no, amount, billable, cost_to_date: costToDate };
  }

  // Bill the customer → recognize revenue + relieve outstanding WIP to cost of services.
  // GL: Dr 1100 AR / Cr 4200 Revenue ; Dr 5800 COGS / Cr 1260 WIP (for the unrecognized cost).
  async bill(code: string, dto: BillDto, user: JwtUser) {
    const db = this.db as any;
    const p = await this.row(code);
    const bill = r2(n(dto.amount));
    if (bill <= 0) throw new BadRequestException({ code: 'BAD_AMOUNT', message: 'Bill amount must be positive', messageTh: 'จำนวนเงินวางบิลต้องมากกว่าศูนย์' });
    const tenantId = p.tenantId ?? user.tenantId ?? null;
    const newBilled = r2(n(p.billedToDate) + bill);
    if (await this.ledger.alreadyPosted('PRJ-BILL', `${code}:${newBilled}`, tenantId)) return { already: true, project_code: code };

    const relieve = r2(Math.max(0, n(p.costToDate) - n(p.recognizedCost)));
    const lines = [
      { account_code: '1100', debit: bill, memo: `AR ${code}` },
      { account_code: '4200', credit: bill, memo: 'Project revenue' },
    ];
    if (relieve > 0) {
      lines.push({ account_code: '5800', debit: relieve, memo: 'Project cost of services' });
      lines.push({ account_code: '1260', credit: relieve, memo: `WIP relieved ${code}` });
    }
    const je: any = await this.ledger.postEntry({ source: 'PRJ-BILL', sourceRef: `${code}:${newBilled}`, tenantId, memo: `Project billing ${code}`, createdBy: user.username, lines });

    await db.update(projects).set({ billedToDate: fx(newBilled, 2), recognizedCost: fx(n(p.recognizedCost) + relieve, 2) }).where(eq(projects.id, Number(p.id)));
    return { project_code: code, entry_no: je.entry_no, billed: bill, revenue: bill, cost_recognized: relieve, margin: r2(bill - relieve) };
  }

  async list(user: JwtUser) {
    const db = this.db as any;
    const rows = await db.select().from(projects).orderBy(desc(projects.id)).limit(100);
    // Aggregate the non-billable (already-expensed) cost per project so the register shows total cost + true margin.
    const nb = await db.select({ pid: projectEntries.projectId, v: sql<string>`coalesce(sum(${projectEntries.amount}),0)` })
      .from(projectEntries).where(eq(projectEntries.billable, false)).groupBy(projectEntries.projectId);
    const nbBy = new Map<number, number>(nb.map((x: any) => [Number(x.pid), n(x.v)]));
    return { projects: rows.map((r: any) => this.fmt(r, nbBy.get(Number(r.id)) ?? 0)), count: rows.length };
  }

  async get(code: string) {
    const db = this.db as any;
    const p = await this.row(code);
    const entries = await db.select().from(projectEntries).where(eq(projectEntries.projectId, Number(p.id))).orderBy(desc(projectEntries.id));
    const nonBillable = r2(entries.filter((e: any) => e.billable === false).reduce((s: number, e: any) => s + n(e.amount), 0));
    return {
      ...this.fmt(p, nonBillable),
      entries: entries.map((e: any) => ({ entry_type: e.entryType, description: e.description, qty: n(e.qty), rate: n(e.rate), amount: n(e.amount), billable: e.billable !== false, entry_date: e.entryDate, entry_no: e.entryNo })),
    };
  }

  private async row(code: string) {
    const [p] = await (this.db as any).select().from(projects).where(eq(projects.projectCode, code)).limit(1);
    if (!p) throw new NotFoundException({ code: 'PROJECT_NOT_FOUND', message: `Project ${code} not found`, messageTh: 'ไม่พบโครงการ' });
    return p;
  }

  private fmt(p: any, nonBillable = 0) {
    const cost = n(p.costToDate), recognized = n(p.recognizedCost), billed = n(p.billedToDate), nb = r2(nonBillable);
    return {
      project_code: p.projectCode, name: p.name, customer_name: p.customerName, billing_type: p.billingType, status: p.status,
      budget_amount: n(p.budgetAmount), contract_amount: n(p.contractAmount),
      cost_to_date: cost, recognized_cost: recognized, billed_to_date: billed,
      non_billable_cost: nb,                       // expensed straight to 5800 (unrecoverable)
      total_cost: r2(cost + nb),                   // all costs incurred (recoverable WIP + non-billable)
      wip: r2(cost - recognized),                  // unbilled BILLABLE cost sitting in 1260
      margin: r2(billed - recognized - nb),        // recognized revenue − recognized billable cost − absorbed non-billable
      start_date: p.startDate, end_date: p.endDate, created_at: p.createdAt,
    };
  }
}

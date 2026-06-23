import { Inject, Injectable, BadRequestException, ForbiddenException, NotFoundException, ConflictException } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import { DRIZZLE, type DrizzleDb } from '../../database/database.module';
import { aiActionRequests } from '../../database/schema';
import { LedgerService } from '../ledger/ledger.service';
import { ProcurementService } from '../procurement/procurement.service';
import type { JwtUser } from '../../common/decorators';

export type AiActionKind = 'journal_entry' | 'purchase_order';

// Each agent-proposable action declares the permission an APPROVER must hold to execute it. The
// proposer needs no such permission — that's the point: a junior/AI proposes, a senior approves.
const KIND_PERMISSION: Record<AiActionKind, string> = {
  journal_entry: 'gl_post',
  purchase_order: 'procurement',
};

export interface ProposeInput { kind: AiActionKind; payload: any; rationale?: string; source?: 'ai' | 'human' }

// Phase D1 — agentic write-ops. The AI never mutates ledgers/POs directly; it files a PENDING request,
// a DIFFERENT authorized human approves it (SoD: approver ≠ proposer + must hold the action's permission),
// and approval executes through the normal service + GL. Every step is tenant-scoped (RLS) and audited.
@Injectable()
export class AiActionService {
  constructor(
    @Inject(DRIZZLE) private readonly db: DrizzleDb,
    private readonly ledger: LedgerService,
    private readonly procurement: ProcurementService,
  ) {}

  private headlineAmount(kind: AiActionKind, payload: any): number {
    if (kind === 'journal_entry') return round2((payload?.lines ?? []).reduce((a: number, l: any) => a + Number(l.debit || 0), 0));
    if (kind === 'purchase_order') return round2((payload?.items ?? []).reduce((a: number, it: any) => a + Number(it.order_qty || 0) * Number(it.unit_price || 0), 0));
    return 0;
  }

  // Validate the shape early so a malformed proposal is rejected at file-time, not approval-time.
  private validate(kind: AiActionKind, payload: any) {
    if (!(kind in KIND_PERMISSION)) throw new BadRequestException({ code: 'BAD_KIND', message: `Unknown action kind ${kind}`, messageTh: 'ชนิดคำสั่งไม่ถูกต้อง' });
    if (kind === 'journal_entry') {
      const lines = payload?.lines;
      if (!Array.isArray(lines) || lines.length < 2) throw new BadRequestException({ code: 'BAD_PAYLOAD', message: 'journal_entry needs ≥2 lines', messageTh: 'รายการบัญชีต้องมีอย่างน้อย 2 บรรทัด' });
      const dr = round2(lines.reduce((a: number, l: any) => a + Number(l.debit || 0), 0));
      const cr = round2(lines.reduce((a: number, l: any) => a + Number(l.credit || 0), 0));
      if (dr !== cr) throw new BadRequestException({ code: 'UNBALANCED', message: `Debits ${dr} ≠ credits ${cr}`, messageTh: 'เดบิตไม่เท่าเครดิต' });
    }
    if (kind === 'purchase_order' && !(payload?.items?.length)) throw new BadRequestException({ code: 'BAD_PAYLOAD', message: 'purchase_order needs items', messageTh: 'ต้องมีรายการสั่งซื้อ' });
  }

  /** File a PENDING action proposal. Called by the agent's write-tools (or a human drafting via AI). */
  async propose(input: ProposeInput, user: JwtUser) {
    this.validate(input.kind, input.payload);
    const db = this.db as any;
    const [r] = await db.insert(aiActionRequests).values({
      tenantId: user.tenantId ?? null,
      kind: input.kind,
      payload: input.payload,
      rationale: input.rationale ?? null,
      amount: String(this.headlineAmount(input.kind, input.payload)),
      status: 'pending',
      proposedBy: user.username,
      source: input.source ?? 'ai',
    }).returning({ id: aiActionRequests.id });
    return { id: Number(r.id), kind: input.kind, status: 'pending', amount: this.headlineAmount(input.kind, input.payload), message: 'Proposed — awaiting human approval', messageTh: 'เสนอแล้ว — รอการอนุมัติจากผู้มีสิทธิ์' };
  }

  async list(status: string | undefined, _user: JwtUser) {
    const db = this.db as any;
    const rows = await db.select().from(aiActionRequests);
    const filtered = status ? rows.filter((r: any) => r.status === status) : rows;
    return { actions: filtered.map(mapRow), count: filtered.length };
  }

  async get(id: number) {
    const db = this.db as any;
    const [r] = await db.select().from(aiActionRequests).where(eq(aiActionRequests.id, id)).limit(1);
    if (!r) throw new NotFoundException({ code: 'NOT_FOUND', message: 'Action not found', messageTh: 'ไม่พบคำสั่ง' });
    return mapRow(r);
  }

  private async load(id: number) {
    const db = this.db as any;
    const [r] = await db.select().from(aiActionRequests).where(eq(aiActionRequests.id, id)).limit(1);
    if (!r) throw new NotFoundException({ code: 'NOT_FOUND', message: 'Action not found', messageTh: 'ไม่พบคำสั่ง' });
    return r;
  }

  /** Approve + EXECUTE a pending action. Enforces SoD (approver ≠ proposer) + the action's permission. */
  async approve(id: number, user: JwtUser) {
    const db = this.db as any;
    const row = await this.load(id);
    if (row.status !== 'pending') throw new ConflictException({ code: 'NOT_PENDING', message: `Action is ${row.status}`, messageTh: 'คำสั่งนี้ไม่ได้อยู่ในสถานะรออนุมัติ' });
    // SoD R-style: the approver must differ from the proposer (no self-approval of one's own AI proposal).
    if (row.proposedBy === user.username) throw new BadRequestException({ code: 'SOD_SELF_APPROVAL', message: 'Approver must differ from proposer', messageTh: 'ผู้อนุมัติต้องไม่ใช่ผู้เสนอ' });
    // The approver must hold the permission required to perform this kind of action.
    const need = KIND_PERMISSION[row.kind as AiActionKind];
    if (!(user.permissions ?? []).includes(need)) throw new ForbiddenException({ code: 'FORBIDDEN', message: `Approving a ${row.kind} requires permission '${need}'`, messageTh: `ต้องมีสิทธิ์ '${need}' จึงจะอนุมัติได้` });

    try {
      const resultRef = await this.execute(row, user);
      await db.update(aiActionRequests).set({ status: 'executed', decidedBy: user.username, decidedAt: new Date(), resultRef }).where(eq(aiActionRequests.id, id));
      return { id, status: 'executed', result_ref: resultRef };
    } catch (e: any) {
      const msg = String(e?.response?.message ?? e?.message ?? e);
      await db.update(aiActionRequests).set({ status: 'failed', decidedBy: user.username, decidedAt: new Date(), errorMessage: msg }).where(eq(aiActionRequests.id, id));
      throw new BadRequestException({ code: 'EXECUTION_FAILED', message: `Execution failed: ${msg}`, messageTh: `ดำเนินการไม่สำเร็จ: ${msg}` });
    }
  }

  async reject(id: number, reason: string | undefined, user: JwtUser) {
    const db = this.db as any;
    const row = await this.load(id);
    if (row.status !== 'pending') throw new ConflictException({ code: 'NOT_PENDING', message: `Action is ${row.status}`, messageTh: 'คำสั่งนี้ไม่ได้อยู่ในสถานะรออนุมัติ' });
    await db.update(aiActionRequests).set({ status: 'rejected', decidedBy: user.username, decidedAt: new Date(), decisionReason: reason ?? null }).where(eq(aiActionRequests.id, id));
    return { id, status: 'rejected' };
  }

  // Dispatch an approved action to the normal service path. resultRef ties the request to the document.
  private async execute(row: any, user: JwtUser): Promise<string> {
    const p = row.payload ?? {};
    if (row.kind === 'journal_entry') {
      const je: any = await this.ledger.postEntry({
        source: 'AI', sourceRef: `AIACT-${row.id}`, tenantId: row.tenantId ?? user.tenantId ?? null,
        memo: p.memo ?? row.rationale ?? `AI action ${row.id}`, createdBy: user.username,
        lines: p.lines,
      });
      return je?.entry_no ?? `AIACT-${row.id}`;
    }
    if (row.kind === 'purchase_order') {
      const po: any = await this.procurement.createPo({ vendor_id: p.vendor_id, vendor_name: p.vendor_name, expected_date: p.expected_date, remarks: p.remarks ?? `AI action ${row.id}`, items: p.items }, user);
      return po?.po_no ?? `AIACT-${row.id}`;
    }
    throw new BadRequestException({ code: 'BAD_KIND', message: `Cannot execute ${row.kind}`, messageTh: 'ไม่สามารถดำเนินการได้' });
  }
}

const round2 = (x: number) => Math.round((Number(x) || 0) * 100) / 100;
function mapRow(r: any) {
  return {
    id: Number(r.id), kind: r.kind, status: r.status, amount: r.amount != null ? Number(r.amount) : null,
    rationale: r.rationale, payload: r.payload, proposed_by: r.proposedBy, source: r.source,
    created_at: r.createdAt, decided_by: r.decidedBy, decided_at: r.decidedAt, decision_reason: r.decisionReason,
    result_ref: r.resultRef, error_message: r.errorMessage,
  };
}

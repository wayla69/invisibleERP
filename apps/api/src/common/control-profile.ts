// SME single-user edition (docs/49, SME-01) — the ONE place the maker-checker (maker ≠ checker)
// invariant lives. Every self-approval block in the system routes through assertMakerChecker instead of
// an inline `createdBy === user.username` throw, so the per-tenant relaxation has exactly one seam:
//
//   • control_profile='enterprise' (default, and every non-SME tenant): behaviour is byte-identical to
//     the historical inline checks — maker === checker ⇒ 403 (the site's own code/messages, default
//     SOD_SELF_APPROVAL). Golden-master / writeflow parity holds.
//   • control_profile='sme' (chosen at company creation; upgrade-only to enterprise): ONE operator may
//     legitimately be both maker and checker, at any amount (owner decision 2026-07-15 — no ceiling),
//     PROVIDED a non-empty justification is supplied. The allowance is never silent: it writes a
//     self_approvals evidence row + an audit_log marker, and the scheduled `sme_self_approval_review`
//     report (SME-01) delivers every such row to the external accountant + the platform owner.
//
// The caller's profile comes from JwtUser.controlProfile, resolved LIVE from the tenants join in
// JwtAuthGuard (L-3 pattern — never from a token claim or client input). Principals with no resolved
// profile (API keys, HQ/god sessions, members) are treated as 'enterprise' — fail-closed.
import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { z } from 'zod';
import type { JwtUser } from './decorators';
import { appendAuditMeta } from './tenant-context';
import { selfApprovals } from '../database/schema';

export type ControlProfile = 'enterprise' | 'sme';
export const CONTROL_PROFILES: ControlProfile[] = ['enterprise', 'sme'];

export interface MakerCheckerCtx {
  /** The acting approver (checker). Profile + tenant are read from this user. */
  user: JwtUser;
  /** The maker (creator/requester) of the document being approved. Null/undefined ⇒ legacy row, no block. */
  maker: string | null | undefined;
  /** Stable event key for SME-01 evidence, e.g. 'gl.je.approve', 'cpq.discount.approve'. */
  event: string;
  /** Business document reference (JE no, quote no, card no, ...). */
  ref: string;
  /** THB at stake when the event is monetary (recorded as evidence; no ceiling is applied). */
  amount?: number | string | null;
  /** The self-approval justification (from the request body's `self_approval_reason`). */
  reason?: string | null;
  /** Override the thrown 403 code/messages so each site keeps its historical error contract. */
  code?: string;
  message?: string;
  messageTh?: string;
  /** A site whose historical block was a 400 BadRequest (e.g. ESS expense) keeps that status. Default 403. */
  httpStatus?: 400 | 403;
}

const profileOf = (user: JwtUser): ControlProfile =>
  user.controlProfile === 'sme' ? 'sme' : 'enterprise';

/**
 * Enforce maker ≠ checker, or — for an 'sme' tenant only — record a justified self-approval.
 * Throws 403 (site's code, default SOD_SELF_APPROVAL) under 'enterprise', 400
 * SELF_APPROVAL_REASON_REQUIRED when an SME self-approval carries no justification.
 * Call INSIDE the approving service, before the approval mutation (same tx not required — the evidence
 * row is written first; if the approval then fails, a surplus evidence row is conservative, never hiding).
 */
export async function assertMakerChecker(db: { insert: Function }, ctx: MakerCheckerCtx): Promise<void> {
  if (!ctx.maker || ctx.maker !== ctx.user.username) return; // different person — the normal checker path

  if (profileOf(ctx.user) !== 'sme' || ctx.user.tenantId == null) {
    const body = {
      code: ctx.code ?? 'SOD_SELF_APPROVAL',
      message: ctx.message ?? 'Maker-checker: the requester cannot approve their own item — a different authorised user must approve',
      messageTh: ctx.messageTh ?? 'ผู้จัดทำไม่สามารถอนุมัติรายการของตนเองได้ ต้องให้ผู้อื่นอนุมัติ (แบ่งแยกหน้าที่)',
    };
    throw ctx.httpStatus === 400 ? new BadRequestException(body) : new ForbiddenException(body);
  }

  const reason = (ctx.reason ?? '').trim();
  if (!reason) {
    throw new BadRequestException({
      code: 'SELF_APPROVAL_REASON_REQUIRED',
      message: 'SME mode: self-approval requires an explicit justification (self_approval_reason) — it is logged and independently reviewed (SME-01)',
      messageTh: 'โหมด SME: การอนุมัติรายการของตนเองต้องระบุเหตุผลประกอบ (self_approval_reason) — ระบบบันทึกและส่งให้ผู้ตรวจอิสระทบทวน (SME-01)',
    });
  }

  const amount = ctx.amount == null || ctx.amount === '' ? null : String(ctx.amount);
  await db.insert(selfApprovals).values({
    tenantId: ctx.user.tenantId, event: ctx.event, ref: ctx.ref,
    username: ctx.user.username, amount, reason,
  });
  appendAuditMeta({ self_approved: { event: ctx.event, ref: ctx.ref, amount, reason } });
}

/** Zod-free validation for admin inputs: is this a known profile value? */
export const isControlProfile = (v: unknown): v is ControlProfile =>
  v === 'enterprise' || v === 'sme';

// Shared OPTIONAL request body for approve endpoints that historically took none. Backward compatible:
// no body / null / {} all validate; only an SME self-approval needs the reason. Sites with an existing
// DTO add `self_approval_reason` to their own zod body instead.
export const SelfApprovalBody = z
  .object({ self_approval_reason: z.string().max(500).optional() })
  .nullish()
  .transform((v) => v ?? {});
export type SelfApprovalDto = { self_approval_reason?: string };

import { Inject, Injectable, BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { eq, and, desc, type SQL } from 'drizzle-orm';
import { DRIZZLE, type DrizzleDb } from '../../database/database.module';
import { employees, essProfileChangeRequests, employeeDocuments } from '../../database/schema';
import { StatusLogService } from '../../common/status-log.service';
import { isSafeObjectKey } from '../../common/object-storage';
import { assertMakerChecker } from '../../common/control-profile';
import type { JwtUser } from '../../common/decorators';

export interface ProfileChangeDto { field: string; new_value: string; reason?: string }
export interface DocumentDto { doc_type: string; title: string; file_ref?: string; visibility?: 'private' | 'hr' }

// HR-8 (docs/42, Wave 3) — Employee Self-Service (ESS) depth. Control HR-08 (profile-change maker-checker):
//   - A change to a SENSITIVE profile field (name / national_id / bank_account / tax_id) is parked `pending`
//     and the employees master is written ONLY when a DIFFERENT hr/hr_admin user approves (approved_by ≠
//     requested_by → SOD_SELF_APPROVAL; an employee CANNOT self-approve). Reject leaves the master unchanged.
//   - A change to a LOW-RISK field (phone / address / emergency_contact) auto-applies at request time.
//   - Own-scope: an `ess` caller may only see/modify their OWN requests + documents; HR/hr_admin see all.
// Applying an approved (or auto-applied) request audit-logs the before/after on doc_status_log (ESSPROFILE).

const HR_ROLES = ['hr', 'hr_admin', 'exec'];

// The ESS-editable profile fields → their employees column + sensitivity. Sensitive fields route through the
// HR-08 maker-checker; low-risk fields auto-apply. A field NOT in this map is rejected (BAD_FIELD).
type EssField = 'name' | 'national_id' | 'bank_account' | 'tax_id' | 'phone' | 'address' | 'emergency_contact';
const FIELD_SENSITIVE: Record<EssField, boolean> = {
  name: true, national_id: true, bank_account: true, tax_id: true,
  phone: false, address: false, emergency_contact: false,
};

@Injectable()
export class HcmEssService {
  constructor(
    @Inject(DRIZZLE) private readonly db: DrizzleDb,
    private readonly statusLog: StatusLogService,
  ) {}

  private isHr(user: JwtUser): boolean {
    return user.role === 'Admin' || (user.permissions ?? []).some((p) => HR_ROLES.includes(p));
  }

  // Resolve the logged-in user → their own employee row (user_name link, emp_code fallback). RLS scopes to the
  // caller's tenant, so this only ever finds an employee in the caller's own company.
  private async me(user: JwtUser) {
    let [emp] = await this.db.select().from(employees).where(eq(employees.userName, user.username)).limit(1);
    if (!emp) [emp] = await this.db.select().from(employees).where(eq(employees.empCode, user.username)).limit(1);
    if (!emp) throw new ForbiddenException({ code: 'ESS_NO_EMPLOYEE', message: 'No employee record linked to this user', messageTh: 'บัญชีนี้ยังไม่ผูกกับพนักงาน' });
    return emp;
  }

  private async empByCode(code: string) {
    const [e] = await this.db.select().from(employees).where(eq(employees.empCode, code)).limit(1);
    if (!e) throw new NotFoundException({ code: 'EMP_NOT_FOUND', message: `Employee ${code} not found`, messageTh: 'ไม่พบพนักงาน' });
    return e;
  }

  // Mask a sensitive value for display (keep only the last 4 chars).
  private mask(v: string | null | undefined): string | null {
    if (v == null) return null;
    if (v.length <= 4) return '••••';
    return `••••${v.slice(-4)}`;
  }

  private oldValueOf(emp: typeof employees.$inferSelect, field: EssField): string | null {
    switch (field) {
      case 'name': return emp.name ?? null;
      case 'national_id': return emp.nationalId ?? null;
      case 'bank_account': return emp.bankAccount ?? null;
      case 'tax_id': return emp.taxId ?? null;
      case 'phone': return emp.phone ?? null;
      case 'address': return emp.address ?? null;
      case 'emergency_contact': return emp.emergencyContact ?? null;
    }
  }

  // Write the named field to the employees master (typed per-field so no dynamic-key cast is needed).
  private async applyToMaster(empCode: string, field: EssField, value: string) {
    switch (field) {
      case 'name': await this.db.update(employees).set({ name: value }).where(eq(employees.empCode, empCode)); break;
      case 'national_id': await this.db.update(employees).set({ nationalId: value }).where(eq(employees.empCode, empCode)); break;
      case 'bank_account': await this.db.update(employees).set({ bankAccount: value }).where(eq(employees.empCode, empCode)); break;
      case 'tax_id': await this.db.update(employees).set({ taxId: value }).where(eq(employees.empCode, empCode)); break;
      case 'phone': await this.db.update(employees).set({ phone: value }).where(eq(employees.empCode, empCode)); break;
      case 'address': await this.db.update(employees).set({ address: value }).where(eq(employees.empCode, empCode)); break;
      case 'emergency_contact': await this.db.update(employees).set({ emergencyContact: value }).where(eq(employees.empCode, empCode)); break;
    }
  }

  private changeOut(r: typeof essProfileChangeRequests.$inferSelect) {
    const sensitive = r.sensitive === 'true';
    return {
      id: Number(r.id), emp_code: r.empCode, field: r.field, sensitive,
      old_value: sensitive ? this.mask(r.oldValue) : (r.oldValue ?? null),
      new_value: sensitive ? this.mask(r.newValue) : r.newValue,
      status: r.status, reason: r.reason ?? null,
      requested_by: r.requestedBy ?? null, approved_by: r.approvedBy ?? null,
    };
  }

  // ── Profile-change requests (HR-08) ─────────────────────────────────────────
  async createRequest(dto: ProfileChangeDto, user: JwtUser) {
    const field = dto.field as EssField;
    if (!(field in FIELD_SENSITIVE))
      throw new BadRequestException({ code: 'BAD_FIELD', message: `Field ${dto.field} is not an ESS-editable profile field`, messageTh: 'ไม่สามารถแก้ไขฟิลด์นี้ผ่านบริการตนเอง' });
    const newValue = (dto.new_value ?? '').trim();
    if (!newValue) throw new BadRequestException({ code: 'BAD_VALUE', message: 'new_value is required', messageTh: 'ต้องระบุค่าที่ต้องการแก้ไข' });

    // The request always targets the caller's OWN record (own-scope) — emp_code is derived from the JWT.
    const emp = await this.me(user);
    const sensitive = FIELD_SENSITIVE[field];
    const oldValue = this.oldValueOf(emp, field);

    if (!sensitive) {
      // Low-risk field: auto-apply immediately and record the change (status `applied`).
      await this.applyToMaster(emp.empCode, field, newValue);
      const [row] = await this.db.insert(essProfileChangeRequests).values({
        tenantId: emp.tenantId ?? user.tenantId ?? null, empCode: emp.empCode, field, oldValue, newValue,
        sensitive: 'false', status: 'applied', reason: dto.reason ?? null, requestedBy: user.username,
        approvedBy: user.username, decidedAt: new Date(),
      }).returning({ id: essProfileChangeRequests.id });
      await this.statusLog.log('ESSPROFILE', String(row!.id), 'Requested', 'Applied', user.username,
        `ESS auto-apply (HR-08 low-risk): ${emp.empCode} ${field} → ${newValue}`);
      return { id: Number(row!.id), emp_code: emp.empCode, field, status: 'applied', sensitive: false, auto_applied: true };
    }

    // Sensitive field: park pending; the employees master is NOT touched until a different HR user approves.
    const [row] = await this.db.insert(essProfileChangeRequests).values({
      tenantId: emp.tenantId ?? user.tenantId ?? null, empCode: emp.empCode, field, oldValue, newValue,
      sensitive: 'true', status: 'pending', reason: dto.reason ?? null, requestedBy: user.username,
    }).returning({ id: essProfileChangeRequests.id });
    return { id: Number(row!.id), emp_code: emp.empCode, field, status: 'pending', sensitive: true, auto_applied: false };
  }

  async listRequests(status: string | undefined, empCode: string | undefined, user: JwtUser) {
    const conds: SQL[] = [];
    if (this.isHr(user)) {
      if (empCode) conds.push(eq(essProfileChangeRequests.empCode, empCode));
    } else {
      // ess own-scope: only the caller's own requests.
      const emp = await this.me(user);
      conds.push(eq(essProfileChangeRequests.empCode, emp.empCode));
    }
    if (status) conds.push(eq(essProfileChangeRequests.status, status));
    const rows = await this.db.select().from(essProfileChangeRequests)
      .where(conds.length ? and(...conds) : undefined).orderBy(desc(essProfileChangeRequests.id)).limit(200);
    return { requests: rows.map((r) => this.changeOut(r)), count: rows.length };
  }

  // HR-08 maker-checker — approve a pending SENSITIVE change. approved_by MUST differ from requested_by
  // (SOD_SELF_APPROVAL); only hr/hr_admin approve (controller-gated). The employees master is written here.
  // Exception (docs/49): an 'sme' tenant may self-approve WITH self_approval_reason — logged, reviewed by SME-01.
  async approveRequest(id: number, user: JwtUser, selfApprovalReason?: string | null) {
    const [r] = await this.db.select().from(essProfileChangeRequests).where(eq(essProfileChangeRequests.id, Number(id))).limit(1);
    if (!r) throw new NotFoundException({ code: 'CHANGE_NOT_FOUND', message: `Change request ${id} not found`, messageTh: 'ไม่พบคำขอแก้ไขข้อมูล' });
    if (r.status === 'approved' || r.status === 'applied') return { id: Number(id), status: r.status, already: true };
    if (r.status === 'rejected') throw new BadRequestException({ code: 'CHANGE_REJECTED', message: 'Change request already rejected', messageTh: 'คำขอถูกปฏิเสธแล้ว' });
    await assertMakerChecker(this.db, { user, maker: r.requestedBy, event: 'hcm.ess-request.approve', ref: String(id), reason: selfApprovalReason, code: 'SOD_SELF_APPROVAL', message: 'The requester cannot approve their own profile change', messageTh: 'ผู้ขอไม่สามารถอนุมัติคำขอของตนเองได้' });

    await this.applyToMaster(r.empCode, r.field as EssField, r.newValue);
    await this.db.update(essProfileChangeRequests)
      .set({ status: 'approved', approvedBy: user.username, decidedAt: new Date() })
      .where(eq(essProfileChangeRequests.id, Number(id)));
    // Audit the before/after (HR-08 evidence). Values masked in the remark for sensitive fields.
    await this.statusLog.log('ESSPROFILE', String(id), 'Pending', 'Approved', user.username,
      `HR-08 approve: ${r.empCode} ${r.field} ${this.mask(r.oldValue)} → ${this.mask(r.newValue)} (requested_by ${r.requestedBy})`);
    return { id: Number(id), emp_code: r.empCode, field: r.field, status: 'approved', approved_by: user.username };
  }

  async rejectRequest(id: number, reason: string | undefined, user: JwtUser) {
    const [r] = await this.db.select().from(essProfileChangeRequests).where(eq(essProfileChangeRequests.id, Number(id))).limit(1);
    if (!r) throw new NotFoundException({ code: 'CHANGE_NOT_FOUND', message: `Change request ${id} not found`, messageTh: 'ไม่พบคำขอแก้ไขข้อมูล' });
    if (r.status === 'approved' || r.status === 'applied') throw new BadRequestException({ code: 'CHANGE_DECIDED', message: 'Change request already applied', messageTh: 'คำขอถูกดำเนินการแล้ว' });
    if (r.status === 'rejected') return { id: Number(id), status: 'rejected', already: true };
    await this.db.update(essProfileChangeRequests)
      .set({ status: 'rejected', approvedBy: user.username, decidedAt: new Date(), reason: reason ?? r.reason })
      .where(eq(essProfileChangeRequests.id, Number(id)));
    await this.statusLog.log('ESSPROFILE', String(id), 'Pending', 'Rejected', user.username,
      `HR-08 reject: ${r.empCode} ${r.field}${reason ? ` — ${reason}` : ''}`);
    return { id: Number(id), emp_code: r.empCode, field: r.field, status: 'rejected' };
  }

  // ── Personal documents (own-scoped) ─────────────────────────────────────────
  private docOut(r: typeof employeeDocuments.$inferSelect) {
    return {
      id: Number(r.id), emp_code: r.empCode, doc_type: r.docType, title: r.title,
      file_ref: r.fileRef ?? null, visibility: r.visibility, uploaded_by: r.uploadedBy ?? null,
      created_at: r.createdAt,
    };
  }

  async listDocuments(empCode: string | undefined, user: JwtUser) {
    const conds: SQL[] = [];
    if (this.isHr(user)) {
      if (empCode) conds.push(eq(employeeDocuments.empCode, empCode));
    } else {
      // ess own-scope: only the caller's own documents. `hr`-visibility docs are hidden from the employee.
      const emp = await this.me(user);
      conds.push(eq(employeeDocuments.empCode, emp.empCode));
      conds.push(eq(employeeDocuments.visibility, 'private'));
    }
    const rows = await this.db.select().from(employeeDocuments)
      .where(conds.length ? and(...conds) : undefined).orderBy(desc(employeeDocuments.id)).limit(200);
    return { documents: rows.map((r) => this.docOut(r)), count: rows.length };
  }

  async uploadDocument(dto: DocumentDto, user: JwtUser) {
    if (!dto.title?.trim()) throw new BadRequestException({ code: 'BAD_TITLE', message: 'title is required', messageTh: 'ต้องระบุชื่อเอกสาร' });
    // An `objstore:<key>` reference must carry a safe object key (isSafeObjectKey — no traversal / host redirect).
    let fileRef = dto.file_ref ?? null;
    if (fileRef && fileRef.startsWith('objstore:')) {
      const key = fileRef.slice('objstore:'.length);
      if (!isSafeObjectKey(key))
        throw new BadRequestException({ code: 'BAD_OBJECT_KEY', message: 'file_ref object key is not safe', messageTh: 'คีย์ไฟล์ไม่ถูกต้อง' });
    }
    // ess uploads to their OWN record; HR may upload to any employee (visibility their choice).
    const emp = this.isHr(user) ? null : await this.me(user);
    const empCode = emp ? emp.empCode : ((await this.empByCode(((dto as unknown as { emp_code?: string }).emp_code) ?? '')).empCode);
    const [row] = await this.db.insert(employeeDocuments).values({
      tenantId: (emp?.tenantId ?? user.tenantId) ?? null, empCode, docType: dto.doc_type, title: dto.title.trim(),
      fileRef, visibility: emp ? 'private' : (dto.visibility ?? 'private'), uploadedBy: user.username,
    }).returning({ id: employeeDocuments.id });
    return { id: Number(row!.id), emp_code: empCode, doc_type: dto.doc_type, title: dto.title.trim(), visibility: emp ? 'private' : (dto.visibility ?? 'private') };
  }

  // ── Team directory (derived read over employees) ────────────────────────────
  // A read-only directory: HR sees the whole company; an ess caller sees their own department. Only
  // non-sensitive public fields are exposed (name, position, department) — never PII.
  async teamDirectory(user: JwtUser) {
    if (this.isHr(user)) {
      const rows = await this.db.select().from(employees).where(eq(employees.active, true)).orderBy(employees.name).limit(500);
      return { team: rows.map((e) => ({ emp_code: e.empCode, name: e.name, position: e.position ?? null, department: e.department ?? null })), count: rows.length, scope: 'company' };
    }
    const emp = await this.me(user);
    const dept = emp.department ?? null;
    const rows = dept
      ? await this.db.select().from(employees).where(and(eq(employees.active, true), eq(employees.department, dept))).orderBy(employees.name).limit(500)
      : [emp];
    return { team: rows.map((e) => ({ emp_code: e.empCode, name: e.name, position: e.position ?? null, department: e.department ?? null })), count: rows.length, scope: dept ? 'department' : 'self', department: dept };
  }
}

import { Inject, Injectable, ForbiddenException } from '@nestjs/common';
import { eq, and } from 'drizzle-orm';
import { DRIZZLE, type DrizzleDb } from '../../database/database.module';
import { sodRules, rolePermissions, users, userPermissions } from '../../database/schema';
import { resolvePermissions, detectSodConflicts, SOD_RULES, type Role, type Permission } from '@ierp/shared';
import type { JwtUser } from '../../common/decorators';

// Segregation of Duties. Two rule kinds: MAKER_CHECKER (a doc's creator may not approve it — also hardcoded
// in the engine for safety) and PERM_PAIR (no single actor may hold two conflicting permissions, e.g.
// create-PO + approve-payment). Consulted at the act-boundary and queryable as a violation report.
@Injectable()
export class SodService {
  constructor(@Inject(DRIZZLE) private readonly db: DrizzleDb) {}

  async createRule(dto: { name: string; kind?: string; doc_type?: string; perm_a?: string; perm_b?: string }, user: JwtUser) {
    const db = this.db as any;
    const [r] = await db.insert(sodRules).values({ tenantId: user.tenantId ?? null, name: dto.name, kind: dto.kind ?? 'PERM_PAIR', docType: dto.doc_type ?? null, permA: dto.perm_a ?? null, permB: dto.perm_b ?? null, active: true }).returning({ id: sodRules.id });
    return { id: Number(r.id) };
  }
  async listRules(_user: JwtUser) {
    const db = this.db as any;
    const rows = await db.select().from(sodRules).orderBy(sodRules.id);
    return { rules: rows.map((r: any) => ({ id: Number(r.id), name: r.name, kind: r.kind, doc_type: r.docType, perm_a: r.permA, perm_b: r.permB, active: r.active })) };
  }
  async setRuleActive(id: number, active: boolean, _user: JwtUser) {
    const db = this.db as any;
    await db.update(sodRules).set({ active }).where(eq(sodRules.id, id));
    return { id, active };
  }

  // Throws ForbiddenException{SOD_VIOLATION} when the actor breaches a configured rule. Reusable by ANY
  // module before a sensitive action.
  async assertActionAllowed(ctx: { tenantId: number | null; docType: string; createdBy: string; actor: string; actorPermissions: string[]; action: string }) {
    const db = this.db as any;
    const rules = await db.select().from(sodRules).where(eq(sodRules.active, true));
    const perms = new Set(ctx.actorPermissions ?? []);
    for (const r of rules) {
      if (r.kind === 'MAKER_CHECKER') {
        if ((r.docType == null || r.docType === ctx.docType) && ctx.actor === ctx.createdBy) {
          throw new ForbiddenException({ code: 'SOD_VIOLATION', message: `Maker-checker: ${ctx.actor} cannot ${ctx.action} their own ${ctx.docType}`, messageTh: 'ผู้สร้างเอกสารทำรายการเองไม่ได้ (แบ่งแยกหน้าที่)' });
        }
      } else if (r.kind === 'PERM_PAIR') {
        if (r.permA && r.permB && perms.has(r.permA) && perms.has(r.permB)) {
          throw new ForbiddenException({ code: 'SOD_VIOLATION', message: `SoD: holding both ${r.permA} and ${r.permB} is forbidden (${r.name})`, messageTh: `ถือสองสิทธิ์ขัดกัน (${r.name})` });
        }
      }
    }
  }

  // Detective control (ITGC-AC-09): per-USER conflict report from the code-level SoD rule registry,
  // evaluated on EFFECTIVE permissions (role defaults + per-user overrides, expanded for sub-permissions).
  // Complements violationReport() (configurable role-level PERM_PAIR rules). Admins are flagged inherent.
  async userConflicts(_user: JwtUser) {
    const db = this.db as any;
    const us = await db.select({ id: users.id, username: users.username, role: users.role }).from(users).orderBy(users.username);
    const ups = await db.select({ userId: userPermissions.userId, perm: userPermissions.perm }).from(userPermissions);
    const byUser = new Map<number, string[]>();
    for (const r of ups) {
      const k = Number(r.userId);
      const arr = byUser.get(k) ?? [];
      arr.push(r.perm);
      byUser.set(k, arr);
    }
    const evaluated = us.map((u: any) => {
      const overrides = byUser.get(Number(u.id)) ?? [];
      const effective = resolvePermissions(u.role as Role, overrides.length ? (overrides as Permission[]) : null);
      const conflicts = detectSodConflicts(effective);
      return { username: u.username, role: u.role, inherent: u.role === 'Admin', conflict_count: conflicts.length, conflicts };
    });
    const flagged = evaluated.filter((x: any) => x.conflict_count > 0 && !x.inherent);
    const byRule: Record<string, number> = {};
    for (const x of flagged) for (const c of x.conflicts) byRule[c.ruleId] = (byRule[c.ruleId] ?? 0) + 1;
    return {
      report: 'Per-user SoD conflict report (effective permissions)',
      rules: SOD_RULES.map((r) => ({ id: r.id, duty_a: r.dutyA, duty_b: r.dutyB, severity: r.severity })),
      summary: {
        total_users: evaluated.length,
        users_with_conflicts: flagged.length,
        admins_inherent: evaluated.filter((x: any) => x.inherent).length,
        by_rule: byRule,
      },
      users: evaluated,
    };
  }

  // Oversight: which ROLES violate an active PERM_PAIR rule (hold both conflicting perms) — read-only.
  async violationReport(_user: JwtUser) {
    const db = this.db as any;
    const rules = await db.select().from(sodRules).where(and(eq(sodRules.active, true), eq(sodRules.kind, 'PERM_PAIR')));
    const violations: any[] = [];
    for (const r of rules) {
      if (!r.permA || !r.permB) continue;
      const rolesA = (await db.select({ role: rolePermissions.role }).from(rolePermissions).where(eq(rolePermissions.perm, r.permA))).map((x: any) => x.role);
      const rolesB = new Set((await db.select({ role: rolePermissions.role }).from(rolePermissions).where(eq(rolePermissions.perm, r.permB))).map((x: any) => x.role));
      for (const role of rolesA) if (rolesB.has(role)) violations.push({ rule: r.name, role, perm_a: r.permA, perm_b: r.permB });
    }
    return { violations, count: violations.length };
  }
}

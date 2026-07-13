import { BadRequestException } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import type { DrizzleDb } from '../../../database/database.module';
import { crmAccounts, crmContacts, crmActivities } from '../../../database/schema';
import { MessagingService } from '../../messaging/messaging.service';
import { n } from '../../../database/queries';
import { newCrmThreadToken, crmThreadMark } from '../crm-thread';
import type { JwtUser } from './../../../common/decorators';

// The facade's opportunity lookup arrives as a callback port (docs/38 pattern) so this class never
// imports the facade at runtime.
export interface CommsPorts {
  oppByNo(oppNo: string, user: JwtUser): Promise<any>;
}

// docs/46 Phase 4b cut 4 — CRM-4 sales comms from the deal timeline (email / LINE / SMS via messaging,
// merge fields, CRM-6 reply-threading token), moved VERBATIM out of crm-pipeline.service.ts. A plain class
// constructed in the CrmPipelineService constructor BODY; the facade keeps thin delegators, so the public
// API is byte-identical.
export class CrmPipelineCommsService {
  static readonly COMMS_MERGE_FIELDS = ['opp.name', 'opp.no', 'opp.amount', 'opp.stage', 'account.name', 'contact.name', 'contact.email', 'owner', 'sender'] as const;

  constructor(private readonly db: DrizzleDb, private readonly ports: CommsPorts, private readonly messaging?: MessagingService) {}

  mergeFields() { return { fields: [...CrmPipelineCommsService.COMMS_MERGE_FIELDS] }; }

  private commsContext(opp: any, account: any, contact: any, user: JwtUser): Record<string, string> {
    return {
      'opp.name': opp.name ?? '', 'opp.no': opp.oppNo ?? '', 'opp.amount': n(opp.amount).toLocaleString('en-US'), 'opp.stage': opp.stage ?? '',
      'account.name': account?.name ?? opp.accountName ?? '', 'contact.name': contact?.name ?? '', 'contact.email': contact?.email ?? '',
      owner: opp.owner ?? user.username, sender: user.username,
    };
  }

  // Presentation-only {{field}} substitution (document-templates merge-field style); an unknown token is left
  // verbatim so a typo is visible rather than silently dropped.
  private renderMergeFields(template: string, ctx: Record<string, string>): string {
    return String(template ?? '').replace(/\{\{\s*([\w.]+)\s*\}\}/g, (_m, k: string) => (k in ctx ? ctx[k]! : `{{${k}}}`));
  }

  // Send an email / LINE / SMS from a deal — merge fields resolved from the opportunity + account + contact,
  // dispatched through the existing MessagingService, and LOGGED as a timeline activity (a completed touch).
  async sendComms(oppNo: string, dto: { channel: 'email' | 'line' | 'sms'; to?: string; subject?: string; body: string; contact_id?: number }, user: JwtUser) {
    const db = this.db;
    if (!this.messaging) throw new BadRequestException({ code: 'MESSAGING_UNAVAILABLE', message: 'Messaging service not available', messageTh: 'ระบบส่งข้อความไม่พร้อมใช้งาน' });
    const o = await this.ports.oppByNo(oppNo, user);
    const [account] = o.accountId != null ? await db.select().from(crmAccounts).where(eq(crmAccounts.id, Number(o.accountId))).limit(1) : [undefined];
    const contactId = dto.contact_id ?? (o.primaryContactId != null ? Number(o.primaryContactId) : null);
    const [contact] = contactId != null ? await db.select().from(crmContacts).where(eq(crmContacts.id, contactId)).limit(1) : [undefined];
    let to = dto.to?.trim() || null;
    if (!to && contact) to = dto.channel === 'email' ? (contact.email ?? null) : dto.channel === 'line' ? (contact.lineId ?? null) : (contact.phone ?? null);
    if (!to) throw new BadRequestException({ code: 'NO_RECIPIENT', message: `No ${dto.channel} recipient on the contact — pass an explicit 'to'`, messageTh: 'ไม่พบผู้รับสำหรับช่องทางนี้' });
    const ctx = this.commsContext(o, account, contact, user);
    const body = this.renderMergeFields(dto.body, ctx);
    const subject = dto.subject ? this.renderMergeFields(dto.subject, ctx) : null;
    // CRM-6: stamp a deterministic reply-threading token and embed it in the dispatched message (subject +
    // body footer) so an inbound reply carrying `[ref:<token>]` threads back to THIS deal even when the
    // sender replies from a different address than the one on file. Only meaningful for email today.
    const threadToken = newCrmThreadToken();
    const composed = subject ? `${subject}\n\n${body}` : body;
    const dispatchBody = dto.channel === 'email' ? `${composed}\n\n${crmThreadMark(threadToken)}` : composed;
    const dispatchSubject = dto.channel === 'email' && subject ? `${subject} ${crmThreadMark(threadToken)}` : subject;
    const res = await this.messaging.send({ to, channel: dto.channel, body: dispatchBody, campaign: 'crm_comms' }, user);
    // Log the send as a timeline activity so it shows in the deal history + Customer-360.
    await db.insert(crmActivities).values({
      tenantId: o.tenantId != null ? Number(o.tenantId) : (user.tenantId ?? null), entityType: 'opportunity', entityNo: oppNo,
      type: dto.channel === 'email' ? 'email' : 'note', subject: subject ?? `${dto.channel.toUpperCase()} → ${to}`,
      notes: body.slice(0, 2000), done: true, owner: user.username, source: 'comms', threadToken, createdBy: user.username,
    });
    return { opp_no: oppNo, channel: dto.channel, to, status: (res as { status?: string })?.status ?? 'sent', subject: dispatchSubject, body, thread_token: threadToken };
  }
}

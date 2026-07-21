// Transactional-email templates (A1) — Thai-first with English secondary, one entry per platform event.
// Pure functions over escaped vars (no imports, no I/O) so vitest covers rendering exhaustively. Every
// var is HTML-escaped before interpolation — template vars carry customer-typed strings (company names).
export type MailTemplateKey =
  | 'signup_approved'
  | 'signup_rejected'
  | 'signup_invite'
  | 'trial_reminder'
  | 'payment_failed'
  | 'company_suspended';

export type MailLang = 'th' | 'en';
export interface RenderedMail { subject: string; html: string; text: string }
export type MailVars = Record<string, string | number | null | undefined>;

export const escapeHtml = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');

const v = (vars: MailVars, key: string): string => escapeHtml(String(vars[key] ?? ''));

// Shared shell: a minimal, client-safe HTML wrapper (transactional mail: no external assets, inline only).
// The title is the raw SUBJECT (a plain-text mail header that may embed customer-typed names) — it must be
// escaped here before it lands inside the <h2>.
const shell = (title: string, bodyHtml: string): string =>
  `<div style="font-family:sans-serif;max-width:560px;margin:0 auto;padding:24px;color:#1e293b">` +
  `<h2 style="margin:0 0 12px">${escapeHtml(title)}</h2>${bodyHtml}` +
  `<p style="margin-top:24px;font-size:12px;color:#64748b">Invisible ERP — อีเมลอัตโนมัติ กรุณาอย่าตอบกลับ / automated message, please do not reply.</p></div>`;

type TemplateFn = (vars: MailVars, lang: MailLang) => RenderedMail;

export const MAIL_TEMPLATES: Record<MailTemplateKey, TemplateFn> = {
  // vars: company, username, login_url
  signup_approved: (vars, lang) => {
    const th = lang === 'th';
    const subject = th
      ? `บริษัท ${String(vars.company ?? '')} เปิดใช้งานแล้ว — เข้าสู่ระบบได้เลย`
      : `${String(vars.company ?? '')} is activated — you can sign in now`;
    const body = th
      ? `<p>คำขอเปิดบริษัท <b>${v(vars, 'company')}</b> ได้รับการอนุมัติแล้ว</p>` +
        `<p>เข้าสู่ระบบด้วยชื่อผู้ใช้ <b>${v(vars, 'username')}</b> และรหัสผ่านที่คุณตั้งไว้ตอนสมัคร</p>` +
        `<p><a href="${v(vars, 'login_url')}">เข้าสู่ระบบ</a></p>`
      : `<p>Your request to open <b>${v(vars, 'company')}</b> has been approved.</p>` +
        `<p>Sign in with username <b>${v(vars, 'username')}</b> and the password you chose at signup.</p>` +
        `<p><a href="${v(vars, 'login_url')}">Sign in</a></p>`;
    const text = th
      ? `คำขอเปิดบริษัท ${vars.company} ได้รับการอนุมัติแล้ว เข้าสู่ระบบด้วยชื่อผู้ใช้ ${vars.username} ที่ ${vars.login_url}`
      : `Your request to open ${vars.company} has been approved. Sign in as ${vars.username} at ${vars.login_url}`;
    return { subject, html: shell(subject, body), text };
  },

  // vars: company, reason?
  signup_rejected: (vars, lang) => {
    const th = lang === 'th';
    const subject = th
      ? `คำขอเปิดบริษัท ${String(vars.company ?? '')} ไม่ได้รับการอนุมัติ`
      : `Your request to open ${String(vars.company ?? '')} was not approved`;
    const reason = vars.reason ? (th ? `<p>เหตุผล: ${v(vars, 'reason')}</p>` : `<p>Reason: ${v(vars, 'reason')}</p>`) : '';
    const body = th
      ? `<p>ขออภัย คำขอเปิดบริษัท <b>${v(vars, 'company')}</b> ไม่ได้รับการอนุมัติ</p>${reason}<p>หากคิดว่าเป็นความผิดพลาด กรุณาติดต่อผู้ดูแลแพลตฟอร์ม</p>`
      : `<p>We are sorry — the request to open <b>${v(vars, 'company')}</b> was not approved.</p>${reason}<p>If you believe this is a mistake, please contact the platform team.</p>`;
    const text = th
      ? `คำขอเปิดบริษัท ${vars.company} ไม่ได้รับการอนุมัติ${vars.reason ? ` เหตุผล: ${vars.reason}` : ''}`
      : `The request to open ${vars.company} was not approved.${vars.reason ? ` Reason: ${vars.reason}` : ''}`;
    return { subject, html: shell(subject, body), text };
  },

  // vars: company?, signup_url (carries the one-time token), expires_at
  signup_invite: (vars, lang) => {
    const th = lang === 'th';
    const subject = th ? 'คำเชิญเปิดบริษัทบน Invisible ERP' : 'Your invite to Invisible ERP';
    const body = th
      ? `<p>คุณได้รับคำเชิญให้เปิดบริษัท${vars.company ? ` <b>${v(vars, 'company')}</b>` : ''} บน Invisible ERP</p>` +
        `<p><a href="${v(vars, 'signup_url')}">สมัครใช้งานด้วยลิงก์เชิญ</a> (ใช้ได้ครั้งเดียว หมดอายุ ${v(vars, 'expires_at')})</p>`
      : `<p>You have been invited to open${vars.company ? ` <b>${v(vars, 'company')}</b>` : ' a company'} on Invisible ERP.</p>` +
        `<p><a href="${v(vars, 'signup_url')}">Sign up with your invite link</a> (single-use, expires ${v(vars, 'expires_at')}).</p>`;
    const text = th
      ? `คำเชิญเปิดบริษัทบน Invisible ERP: ${vars.signup_url} (ใช้ได้ครั้งเดียว หมดอายุ ${vars.expires_at})`
      : `Your Invisible ERP invite: ${vars.signup_url} (single-use, expires ${vars.expires_at})`;
    return { subject, html: shell(subject, body), text };
  },

  // vars: company, days_left, trial_ends_at, billing_url
  trial_reminder: (vars, lang) => {
    const th = lang === 'th';
    const subject = th
      ? `ช่วงทดลองใช้ของ ${String(vars.company ?? '')} จะหมดในอีก ${String(vars.days_left ?? '')} วัน`
      : `${String(vars.company ?? '')}: your trial ends in ${String(vars.days_left ?? '')} day(s)`;
    const body = th
      ? `<p>ช่วงทดลองใช้ของ <b>${v(vars, 'company')}</b> จะหมดอายุวันที่ <b>${v(vars, 'trial_ends_at')}</b></p>` +
        `<p>เลือกแพ็กเกจและชำระเงินได้ที่ <a href="${v(vars, 'billing_url')}">หน้าแพ็กเกจ & การชำระเงิน</a> เพื่อใช้งานต่อเนื่อง</p>`
      : `<p>The trial for <b>${v(vars, 'company')}</b> ends on <b>${v(vars, 'trial_ends_at')}</b>.</p>` +
        `<p>Pick a plan and pay on the <a href="${v(vars, 'billing_url')}">billing page</a> to keep going without interruption.</p>`;
    const text = th
      ? `ช่วงทดลองใช้ของ ${vars.company} จะหมดวันที่ ${vars.trial_ends_at} — เลือกแพ็กเกจได้ที่ ${vars.billing_url}`
      : `The trial for ${vars.company} ends on ${vars.trial_ends_at} — choose a plan at ${vars.billing_url}`;
    return { subject, html: shell(subject, body), text };
  },

  // vars: company, billing_url
  payment_failed: (vars, lang) => {
    const th = lang === 'th';
    const subject = th
      ? `การชำระเงินของ ${String(vars.company ?? '')} ไม่สำเร็จ — กรุณาตรวจสอบ`
      : `Payment failed for ${String(vars.company ?? '')} — action needed`;
    const body = th
      ? `<p>การเรียกเก็บเงินรอบล่าสุดของ <b>${v(vars, 'company')}</b> ไม่สำเร็จ</p>` +
        `<p>กรุณาอัปเดตวิธีชำระเงินที่ <a href="${v(vars, 'billing_url')}">หน้าการชำระเงิน</a> เพื่อไม่ให้การใช้งานถูกระงับ</p>`
      : `<p>The latest charge for <b>${v(vars, 'company')}</b> did not go through.</p>` +
        `<p>Please update your payment method on the <a href="${v(vars, 'billing_url')}">billing page</a> to avoid suspension.</p>`;
    const text = th
      ? `การชำระเงินของ ${vars.company} ไม่สำเร็จ — อัปเดตวิธีชำระเงินที่ ${vars.billing_url}`
      : `Payment failed for ${vars.company} — update your payment method at ${vars.billing_url}`;
    return { subject, html: shell(subject, body), text };
  },

  // vars: company, reason?
  company_suspended: (vars, lang) => {
    const th = lang === 'th';
    const subject = th
      ? `การใช้งานของ ${String(vars.company ?? '')} ถูกระงับชั่วคราว`
      : `${String(vars.company ?? '')} has been suspended`;
    const reason = vars.reason ? (th ? `<p>เหตุผล: ${v(vars, 'reason')}</p>` : `<p>Reason: ${v(vars, 'reason')}</p>`) : '';
    const body = th
      ? `<p>การเข้าใช้งานของ <b>${v(vars, 'company')}</b> ถูกระงับชั่วคราว</p>${reason}<p>กรุณาติดต่อผู้ดูแลแพลตฟอร์มเพื่อคืนสถานะการใช้งาน</p>`
      : `<p>Access for <b>${v(vars, 'company')}</b> has been suspended.</p>${reason}<p>Please contact the platform team to reactivate.</p>`;
    const text = th
      ? `การใช้งานของ ${vars.company} ถูกระงับชั่วคราว${vars.reason ? ` เหตุผล: ${vars.reason}` : ''}`
      : `${vars.company} has been suspended.${vars.reason ? ` Reason: ${vars.reason}` : ''}`;
    return { subject, html: shell(subject, body), text };
  },
};

export const isMailTemplateKey = (x: unknown): x is MailTemplateKey =>
  typeof x === 'string' && Object.prototype.hasOwnProperty.call(MAIL_TEMPLATES, x);

export function renderMail(template: MailTemplateKey, vars: MailVars, lang: MailLang): RenderedMail {
  return MAIL_TEMPLATES[template](vars ?? {}, lang === 'en' ? 'en' : 'th');
}

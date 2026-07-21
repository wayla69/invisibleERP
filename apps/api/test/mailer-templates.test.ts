import { describe, expect, it } from 'vitest';
import { MAIL_TEMPLATES, escapeHtml, isMailTemplateKey, renderMail, type MailTemplateKey } from '../src/modules/mailer/mailer-templates';

// A1 — transactional-email template rendering: every template renders in BOTH languages with a non-empty
// subject/html/text, customer-typed vars are HTML-escaped (company names carry free text), and links land
// in the html. Pure functions — no I/O.
describe('mailer templates (A1)', () => {
  const VARS = {
    company: 'ร้าน <ทดสอบ> & Sons', username: 'owner1', login_url: 'https://app.example/login',
    signup_url: 'https://app.example/signup?invite_token=tok', expires_at: '2026-08-01T00:00:00Z',
    days_left: 3, trial_ends_at: '2026-08-01', billing_url: 'https://app.example/billing', reason: 'ข้อมูล<ไม่ครบ>',
  };

  it('renders every template in th and en with subject/html/text', () => {
    for (const key of Object.keys(MAIL_TEMPLATES) as MailTemplateKey[]) {
      for (const lang of ['th', 'en'] as const) {
        const r = renderMail(key, VARS, lang);
        expect(r.subject.length, `${key}/${lang} subject`).toBeGreaterThan(0);
        expect(r.html, `${key}/${lang} html`).toContain('<div');
        expect(r.text.length, `${key}/${lang} text`).toBeGreaterThan(0);
      }
    }
  });

  it('HTML-escapes customer-typed vars in html bodies', () => {
    const r = renderMail('signup_approved', VARS, 'th');
    expect(r.html).toContain('ร้าน &lt;ทดสอบ&gt; &amp; Sons');
    expect(r.html).not.toContain('<ทดสอบ>');
    const rej = renderMail('signup_rejected', VARS, 'en');
    expect(rej.html).toContain('ข้อมูล&lt;ไม่ครบ&gt;');
  });

  it('carries the actionable link and omits the reason line when absent', () => {
    const inv = renderMail('signup_invite', VARS, 'en');
    expect(inv.html).toContain('https://app.example/signup?invite_token=tok');
    const rejNoReason = renderMail('signup_rejected', { company: 'X' }, 'th');
    expect(rejNoReason.html).not.toContain('เหตุผล:');
  });

  it('escapeHtml + template-key guard behave', () => {
    expect(escapeHtml(`<a b="c">&'`)).toBe('&lt;a b=&quot;c&quot;&gt;&amp;&#39;');
    expect(isMailTemplateKey('signup_approved')).toBe(true);
    expect(isMailTemplateKey('nope')).toBe(false);
  });

  it('unknown lang falls back to Thai', () => {
    const r = renderMail('trial_reminder', VARS, 'xx' as never);
    expect(r.subject).toContain('ช่วงทดลองใช้');
  });
});

import { Inject, Injectable } from '@nestjs/common';
import { z } from 'zod';
import { DRIZZLE, type DrizzleDb } from '../../database/database.module';
import { llmClient } from '../../common/llm-client';
import { modelFor, aiDpaBlocked } from '../../common/ai-models';
import { aiTenantOptedOut } from '../../common/ai-consent';

// LP-2 (docs/31) — a copilot DRAFT: which text-command handler to replay on confirm + its args.
// pr: args = [full `pr …` command text] · expense/advance: [fund, amount, reason] · leave: [from, days, reason]
export type CopilotDraft = { kind: 'pr' | 'expense' | 'advance' | 'leave'; args: string[]; summary: string };

export const DRAFT_LABEL: Record<CopilotDraft['kind'], { btn: string; title: string }> = {
  pr: { btn: 'ยืนยันสร้าง PR', title: 'ร่างคำขอซื้อ' },
  expense: { btn: 'ยืนยันเบิกเงิน', title: 'ร่างคำขอเบิกเงินสดย่อย' },
  advance: { btn: 'ยืนยันยืมเงิน', title: 'ร่างคำขอยืมเงินสดย่อย' },
  leave: { btn: 'ยืนยันส่งใบลา', title: 'ร่างใบลา' },
};

// LP-2 — LLM refinement behind the same seam as doc-ai/nl-analytics: DPA-gated, chat-scoped model
// (`chat_copilot`), STRICT schema validation (a malformed/unknown answer drafts nothing), and a
// per-tenant daily call cap so a chatty OA can't burn the token budget.
const LLM_DRAFT_SCHEMA = z.discriminatedUnion('intent', [
  z.object({ intent: z.literal('pr'), item_id: z.string().min(1).max(40), qty: z.number().positive(), reason: z.string().max(200).optional() }),
  z.object({ intent: z.literal('expense'), fund: z.string().min(1).max(40), amount: z.number().positive(), reason: z.string().max(200).optional() }),
  z.object({ intent: z.literal('advance'), fund: z.string().min(1).max(40), amount: z.number().positive(), reason: z.string().max(200).optional() }),
  z.object({ intent: z.literal('leave'), from_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), days: z.number().int().positive().max(60), reason: z.string().max(200).optional() }),
  z.object({ intent: z.literal('unknown') }),
]);

// Copilot DRAFT parsing extracted from line-webhook.controller.ts (2026-07-09 decomposition; behaviour
// byte-identical — deterministic rules first, LLM refinement second, both feeding the same mk* draft
// constructors). The webhook service still owns confirm-state persistence + the flex card + execution.
@Injectable()
export class LineCopilotService {
  constructor(@Inject(DRIZZLE) private readonly db: DrizzleDb) {}

  // Deterministic key-less draft rules (CI-stable; the LLM path refines when configured). Linear,
  // anchored regexes over chat text capped at 2000 chars — no backtracking-prone nesting.
  rules(t: string): CopilotDraft | null {
    const pr = /(?:ขอซื้อ|อยากได้|สั่งซื้อ|ซื้อ)\s+([A-Za-z0-9-]+)\s+(?:จำนวน\s*)?(\d+(?:\.\d+)?)\s*(?:ชิ้น|อัน|กล่อง|รีม|แพ็ค)?\s*(.*)$/.exec(t);
    if (pr && Number(pr[2]) > 0) return this.mkPrDraft(pr[1]!, pr[2]!, pr[3] ?? '');
    // expense/advance — "เบิก <กองทุน> <จำนวน> [เหตุผล]" or "เบิก <จำนวน> [บาท] จาก <กองทุน> [เหตุผล]"
    const expA = /^(?:ขอเบิก|เบิกเงิน|เบิก)\s+([A-Za-z][A-Za-z0-9-]*)\s+(\d+(?:\.\d+)?)\s*(?:บาท)?\s*(.*)$/.exec(t);
    if (expA) return this.mkMoneyDraft('expense', expA[1]!, expA[2]!, expA[3] ?? '');
    const expB = /^(?:ขอเบิก|เบิกเงิน|เบิก)\s+(\d+(?:\.\d+)?)\s*(?:บาท)?\s*จาก\s*([A-Za-z0-9-]+)\s*(.*)$/.exec(t);
    if (expB) return this.mkMoneyDraft('expense', expB[2]!, expB[1]!, expB[3] ?? '');
    const advA = /^(?:ขอยืมเงิน|ยืมเงิน|ขอยืม)\s+([A-Za-z][A-Za-z0-9-]*)\s+(\d+(?:\.\d+)?)\s*(?:บาท)?\s*(.*)$/.exec(t);
    if (advA) return this.mkMoneyDraft('advance', advA[1]!, advA[2]!, advA[3] ?? '');
    const advB = /^(?:ขอยืมเงิน|ยืมเงิน|ขอยืม)\s+(\d+(?:\.\d+)?)\s*(?:บาท)?\s*จาก\s*([A-Za-z0-9-]+)\s*(.*)$/.exec(t);
    if (advB) return this.mkMoneyDraft('advance', advB[2]!, advB[1]!, advB[3] ?? '');
    // leave — "ลา <YYYY-MM-DD> <วัน>" or "ลา <n> วัน ตั้งแต่ <YYYY-MM-DD>"
    const lvA = /^(?:ขอ)?ลา(?:งาน|ป่วย|กิจ|พักร้อน)?\s+(?:วันที่\s*)?(\d{4}-\d{2}-\d{2})\s+(\d+)\s*(?:วัน)?\s*(.*)$/.exec(t);
    if (lvA) return this.mkLeaveDraft(lvA[1]!, lvA[2]!, lvA[3] ?? '');
    const lvB = /^(?:ขอ)?ลา(?:งาน|ป่วย|กิจ|พักร้อน)?\s+(\d+)\s*วัน\s*(?:ตั้งแต่|จาก|เริ่ม)?\s*(?:วันที่\s*)?(\d{4}-\d{2}-\d{2})\s*(.*)$/.exec(t);
    if (lvB) return this.mkLeaveDraft(lvB[2]!, lvB[1]!, lvB[3] ?? '');
    return null;
  }

  private mkPrDraft(itemId: string, qty: string, reason: string): CopilotDraft | null {
    if (!(Number(qty) > 0)) return null;
    const r = reason.trim();
    return { kind: 'pr', args: [`pr ${itemId.toUpperCase()} ${qty}${r ? ` ${r}` : ''}`], summary: `${itemId.toUpperCase()} × ${qty}${r ? ` (${r})` : ''}` };
  }
  private mkMoneyDraft(kind: 'expense' | 'advance', fund: string, amount: string, reason: string): CopilotDraft | null {
    if (!(Number(amount) > 0)) return null;
    const r = reason.trim();
    return { kind, args: [fund.toUpperCase(), amount, r], summary: `${fund.toUpperCase()} จำนวน ${amount} บาท${r ? ` (${r})` : ''}` };
  }
  private mkLeaveDraft(fromDate: string, days: string, reason: string): CopilotDraft | null {
    const d = Number(days);
    if (!(d > 0 && d <= 60)) return null;
    const r = reason.trim();
    return { kind: 'leave', args: [fromDate, days, r], summary: `ตั้งแต่ ${fromDate} จำนวน ${days} วัน${r ? ` (${r})` : ''}` };
  }

  private readonly llmDaily = new Map<number, { day: string; n: number }>();
  private llmCapped(tenantId: number, onCap?: (cap: number) => void): boolean {
    const cap = Number(process.env.LINE_COPILOT_DAILY_CAP ?? 200);
    if (!(cap > 0)) return false;
    const day = new Date(Date.now() + 7 * 3600_000).toISOString().slice(0, 10); // Bangkok business day
    const e = this.llmDaily.get(tenantId);
    if (!e || e.day !== day) { this.llmDaily.set(tenantId, { day, n: 1 }); return false; }
    e.n++;
    if (e.n === cap + 1) onCap?.(cap); // exactly-once audit hook (the webhook service logs [chat:ai-cap])
    return e.n > cap;
  }

  async llm(tenantId: number, t: string, onCap?: (cap: number) => void): Promise<CopilotDraft | null> {
    if (aiDpaBlocked() || !process.env.ANTHROPIC_API_KEY) return null;
    if (await aiTenantOptedOut(this.db, tenantId)) return null; // PDPA opt-out → keyword parser only
    if (this.llmCapped(tenantId, onCap)) return null;
    try {
      const res: any = await llmClient(process.env.ANTHROPIC_API_KEY).create({
        model: modelFor('chat_copilot'), max_tokens: 300,
        system: 'You draft ERP commands from Thai/English staff chat. Return ONLY one JSON object: '
          + '{"intent":"pr","item_id":string,"qty":number,"reason":string} | '
          + '{"intent":"expense","fund":string,"amount":number,"reason":string} | '
          + '{"intent":"advance","fund":string,"amount":number,"reason":string} | '
          + '{"intent":"leave","from_date":"YYYY-MM-DD","days":number,"reason":string} | '
          + '{"intent":"unknown"}. Draft only — never invent item/fund codes or dates that are not in the message; when unsure return unknown.',
        messages: [{ role: 'user', content: t }],
      });
      const rawText = (res.content as Array<{ type: string; text?: string }>).filter((b) => b.type === 'text').map((b) => b.text ?? '').join('');
      const parsed = LLM_DRAFT_SCHEMA.safeParse(JSON.parse(rawText));
      if (!parsed.success || parsed.data.intent === 'unknown') return null;
      const d = parsed.data;
      if (d.intent === 'pr') return this.mkPrDraft(d.item_id, String(d.qty), d.reason ?? '');
      if (d.intent === 'expense' || d.intent === 'advance') return this.mkMoneyDraft(d.intent, d.fund, String(d.amount), d.reason ?? '');
      return this.mkLeaveDraft(d.from_date, String(d.days), d.reason ?? '');
    } catch { return null; } // malformed JSON / provider error → honest refusal upstream
  }
}

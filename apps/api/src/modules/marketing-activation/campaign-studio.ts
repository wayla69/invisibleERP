// AI Campaign Studio — the PURE, deterministic fact-grounded draft generator (docs/61 Phase 4, MKT-21).
// No DB, no IO, no network — a segment FACT SHEET in, a structured campaign DRAFT + the grounding prompt out,
// so the same facts always yield the same draft and it is unit-tested (campaign-studio.test.ts). This is the
// deterministic path (model 'studio-template-v1'); a live LLM can be swapped in behind the same fact sheet +
// prompt without changing the control (grounded → draft-only → logged). It NEVER contacts anyone.

export interface SegmentFactSheet {
  segment: string;
  count: number;
  avg_clv: number | null;
  dominant_nba: string | null;
  best_channel: string | null;   // by MMM ROI
  best_channel_roi: number | null;
  send_hour: number | null;      // 0..23 Asia/Bangkok, modal preferred_hour
  top_offer: string | null;      // a featured product/offer hint (from Tool ③), optional
  tone: string | null;           // strategic tone from the pushed TOWS (docs/62 Phase 3), optional
}

// Strategic TONE from the pushed TOWS matrix (docs/62 Phase 3 — closes the "TOWS informs nothing" gap):
// the dominant quadrant of the platform's own strategy items sets the copy's voice, so an aggressive-growth
// tenant and a defend-the-base tenant get differently-toned drafts from the same NBA facts. Pure and
// deterministic; ties break toward the more confident stance (SO > ST > WO > WT). Unknown/empty → null
// (the prompt then states "(neutral)" — no tone is ever invented).
const TOWS_TONE: Record<string, string> = {
  SO: 'confident-growth',       // strengths × opportunities → lean in, expansive voice
  ST: 'reassuring-strength',    // strengths × threats → steady, trust-anchored voice
  WO: 'candid-improvement',     // weaknesses × opportunities → honest, we-are-getting-better voice
  WT: 'cautious-care',          // weaknesses × threats → careful, relationship-first voice
};
const TOWS_ORDER = ['SO', 'ST', 'WO', 'WT'] as const;

export function toneFromTows(items: unknown): string | null {
  if (!Array.isArray(items) || !items.length) return null;
  const mix: Record<string, number> = {};
  for (const it of items) {
    const q = String((it as { quadrant?: unknown } | null)?.quadrant ?? '').toUpperCase();
    if (q in TOWS_TONE) mix[q] = (mix[q] ?? 0) + 1;
  }
  const dominant = TOWS_ORDER
    .filter((q) => (mix[q] ?? 0) > 0)
    .sort((a, b) => (mix[b] ?? 0) - (mix[a] ?? 0) || TOWS_ORDER.indexOf(a) - TOWS_ORDER.indexOf(b))[0];
  return dominant ? TOWS_TONE[dominant]! : null;
}

// Bilingual copy per next-best-action — the "right words" grounded in what the segment needs. Interpretable
// and deterministic; a live LLM would enrich these, but the control (fact-grounded, draft-only) is identical.
const NBA_COPY: Record<string, { th: string; en: string; offer_th: string; offer_en: string }> = {
  WINBACK: { th: 'คิดถึงคุณ! กลับมาลองเมนูโปรดพร้อมส่วนลดพิเศษ', en: 'We miss you — come back for a special welcome-back offer', offer_th: 'ส่วนลด 20% สำหรับการกลับมา', offer_en: '20% welcome-back discount' },
  REACTIVATE: { th: 'นานแล้วนะ! มีของขวัญรอคุณอยู่', en: "It's been a while — a little gift is waiting", offer_th: 'รับแต้มพิเศษเมื่อกลับมาใช้บริการ', offer_en: 'Bonus points on your next visit' },
  UPSELL: { th: 'อัปเกรดประสบการณ์ของคุณกับเมนูพรีเมียม', en: 'Upgrade your experience with our premium picks', offer_th: 'เพิ่มเพียงเล็กน้อยรับเมนูพิเศษ', offer_en: 'Add a little, get a lot' },
  CROSS_SELL: { th: 'จับคู่เมนูโปรดของคุณให้อร่อยยิ่งขึ้น', en: 'Pair your favourite with something new', offer_th: 'ซื้อคู่รับส่วนลด', offer_en: 'Buy together and save' },
  VIP_CARE: { th: 'ขอบคุณที่เป็นคนพิเศษของเรา รับสิทธิพิเศษเฉพาะคุณ', en: 'Thank you for being a VIP — enjoy an exclusive perk', offer_th: 'สิทธิพิเศษเฉพาะสมาชิก VIP', offer_en: 'Exclusive VIP perk' },
  RETAIN: { th: 'เราอยากให้คุณอยู่กับเราต่อไป รับข้อเสนอพิเศษ', en: "We'd love to keep you — here's a little thank-you", offer_th: 'สิทธิพิเศษรักษาสมาชิก', offer_en: 'A loyalty thank-you' },
  NURTURE: { th: 'มีอะไรใหม่ ๆ มาให้คุณลอง', en: 'Something new we think you will love', offer_th: 'แนะนำเมนูใหม่', offer_en: 'Discover our latest' },
};
const DEFAULT_COPY = NBA_COPY.NURTURE!;

const clampHour = (h: number | null): number => (h == null || !Number.isFinite(h) ? 18 : Math.max(0, Math.min(23, Math.round(h))));

export interface CampaignDraft {
  audience: 'mi_segment';
  segment: string;
  channel: string;
  send_hour: number;
  offer_th: string;
  offer_en: string;
  subject_th: string;
  subject_en: string;
  body_th: string;
  body_en: string;
  predicted_reach: number;
  suggested_holdout_pct: number;
  grounded_on: SegmentFactSheet;
}

// Build the retrieval-grounded PROMPT — every fact stated explicitly so the generator (template or LLM)
// grounds on data, never hallucinates. Logged as the model card.
export function buildPrompt(f: SegmentFactSheet): string {
  const parts = [
    `Draft a bilingual (Thai + English) marketing campaign for the customer segment "${f.segment}".`,
    `Facts (ground the copy ONLY on these — do not invent):`,
    `- segment size: ${f.count} members`,
    `- average predicted CLV: ${f.avg_clv == null ? 'unknown' : `฿${f.avg_clv}`}`,
    `- dominant next-best-action: ${f.dominant_nba ?? 'none'}`,
    `- best channel (by MMM ROI): ${f.best_channel ?? 'unknown'}${f.best_channel_roi == null ? '' : ` (ROI ${f.best_channel_roi})`}`,
    `- best send-hour (Asia/Bangkok): ${f.send_hour == null ? 'unknown' : `${clampHour(f.send_hour)}:00`}`,
    f.top_offer ? `- product to feature: ${f.top_offer}` : `- product to feature: (none identified)`,
    `- strategic tone (from the TOWS matrix): ${f.tone ?? '(neutral)'}`,
    `Output: audience, channel, send-time, an offer, and short th/en subject + body. The result is a DRAFT for human review — it must not be sent automatically, and only consented members may ever be contacted.`,
  ];
  return parts.join('\n');
}

// Produce the deterministic fact-grounded draft. Channel/send-hour come from the facts; copy from the
// dominant NBA; reach = size × a channel-independent baseline; holdout auto-suggested for lift measurement.
export function draftCampaign(f: SegmentFactSheet): CampaignDraft {
  const nba = (f.dominant_nba ?? '').toUpperCase();
  const copy = NBA_COPY[nba] ?? DEFAULT_COPY;
  const channel = f.best_channel && String(f.best_channel).trim() ? String(f.best_channel) : 'sms';
  const hour = clampHour(f.send_hour);
  const offer_th = f.top_offer ? `${copy.offer_th} · ${f.top_offer}` : copy.offer_th;
  const offer_en = f.top_offer ? `${copy.offer_en} · ${f.top_offer}` : copy.offer_en;
  return {
    audience: 'mi_segment',
    segment: f.segment,
    channel,
    send_hour: hour,
    offer_th, offer_en,
    subject_th: `${copy.th}`,
    subject_en: `${copy.en}`,
    body_th: `${copy.th} — ${offer_th} (กลุ่ม ${f.segment}). ส่งเวลา ${hour}:00`,
    body_en: `${copy.en} — ${offer_en} (segment ${f.segment}). Best sent around ${hour}:00`,
    predicted_reach: Math.max(0, Math.round((Number(f.count) || 0) * 0.8)), // consent/deliverability haircut
    suggested_holdout_pct: 20,
    grounded_on: f,
  };
}

// Variant B — the same grounded facts, a DIFFERENT creative angle (docs/62 Phase 3 A/B): offer-FIRST framing
// where variant A leads with the sentiment. Deterministic, so the A/B contrast is a real creative contrast,
// never noise; the send-time split itself is the existing per-member bucketPct on the campaign.
export interface VariantCopy {
  subject_th: string;
  subject_en: string;
  body_th: string;
  body_en: string;
}

export function draftVariantB(f: SegmentFactSheet): VariantCopy {
  const nba = (f.dominant_nba ?? '').toUpperCase();
  const copy = NBA_COPY[nba] ?? DEFAULT_COPY;
  const hour = clampHour(f.send_hour);
  const offer_th = f.top_offer ? `${copy.offer_th} · ${f.top_offer}` : copy.offer_th;
  const offer_en = f.top_offer ? `${copy.offer_en} · ${f.top_offer}` : copy.offer_en;
  return {
    subject_th: `${offer_th} — เฉพาะคุณ`,
    subject_en: `${offer_en} — just for you`,
    body_th: `${offer_th} วันนี้! ${copy.th} (กลุ่ม ${f.segment}). ส่งเวลา ${hour}:00`,
    body_en: `${offer_en} today! ${copy.en} (segment ${f.segment}). Best sent around ${hour}:00`,
  };
}

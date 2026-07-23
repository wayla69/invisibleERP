import { describe, it, expect } from 'vitest';
import { buildPrompt, draftCampaign, draftVariantB, toneFromTows, type SegmentFactSheet } from '../src/modules/marketing-activation/campaign-studio';

// AI Campaign Studio draft generator (docs/61 Phase 4, MKT-21). Pure, deterministic, fact-grounded.

const sheet = (over: Partial<SegmentFactSheet> = {}): SegmentFactSheet => ({
  segment: 'At Risk VIPs', count: 120, avg_clv: 8400.5, dominant_nba: 'WINBACK',
  best_channel: 'facebook', best_channel_roi: 3.2, send_hour: 19, top_offer: null, tone: null, ...over,
});

describe('buildPrompt', () => {
  it('embeds every fact so the generator grounds on data (retrieval-grounded, not hallucinated)', () => {
    const p = buildPrompt(sheet());
    expect(p).toContain('At Risk VIPs');
    expect(p).toContain('120 members');
    expect(p).toContain('฿8400.5');
    expect(p).toContain('WINBACK');
    expect(p).toContain('facebook');
    expect(p).toContain('19:00');
    expect(p).toMatch(/DRAFT for human review/i);
  });
  it('states unknowns explicitly rather than inventing them', () => {
    const p = buildPrompt(sheet({ avg_clv: null, best_channel: null, send_hour: null }));
    expect(p).toContain('average predicted CLV: unknown');
    expect(p).toContain('best channel (by MMM ROI): unknown');
    expect(p).toContain('strategic tone (from the TOWS matrix): (neutral)'); // no TOWS → neutral, never invented
  });

  it('carries the TOWS-derived strategic tone into the prompt (docs/62 Phase 3)', () => {
    const p = buildPrompt(sheet({ tone: 'confident-growth' }));
    expect(p).toContain('strategic tone (from the TOWS matrix): confident-growth');
  });
});

describe('toneFromTows', () => {
  const item = (quadrant: string) => ({ quadrant, factor: 'x', recommendation: 'y', priority: 1 });
  it('maps the dominant quadrant to its tone', () => {
    expect(toneFromTows([item('SO'), item('SO'), item('WT')])).toBe('confident-growth');
    expect(toneFromTows([item('ST')])).toBe('reassuring-strength');
    expect(toneFromTows([item('WO'), item('WO')])).toBe('candid-improvement');
    expect(toneFromTows([item('WT'), item('WT'), item('WO')])).toBe('cautious-care');
  });
  it('breaks a tie toward the more confident stance (SO > ST > WO > WT)', () => {
    expect(toneFromTows([item('WT'), item('SO')])).toBe('confident-growth');
    expect(toneFromTows([item('WO'), item('ST')])).toBe('reassuring-strength');
  });
  it('returns null for empty, missing, or unknown-quadrant input (never invents a tone)', () => {
    expect(toneFromTows([])).toBeNull();
    expect(toneFromTows(null)).toBeNull();
    expect(toneFromTows('not-an-array')).toBeNull();
    expect(toneFromTows([{ quadrant: 'XX' }, {}])).toBeNull();
  });
  it('is case-insensitive on the quadrant', () => {
    expect(toneFromTows([{ quadrant: 'so' }])).toBe('confident-growth');
  });
});

describe('draftCampaign', () => {
  it('grounds channel + send-hour on the facts and copy on the dominant NBA', () => {
    const d = draftCampaign(sheet());
    expect(d.audience).toBe('mi_segment');
    expect(d.channel).toBe('facebook');       // from best_channel
    expect(d.send_hour).toBe(19);             // from send_hour
    expect(d.subject_th).toContain('คิดถึงคุณ'); // WINBACK copy
    expect(d.subject_en).toMatch(/miss you/i);
    expect(d.suggested_holdout_pct).toBe(20);
  });

  it('predicted reach applies a consent/deliverability haircut to the segment size', () => {
    expect(draftCampaign(sheet({ count: 100 })).predicted_reach).toBe(80);
  });

  it('falls back to sms + a nurture copy + hour 18 when facts are missing', () => {
    const d = draftCampaign(sheet({ best_channel: null, send_hour: null, dominant_nba: null }));
    expect(d.channel).toBe('sms');
    expect(d.send_hour).toBe(18);
    expect(d.subject_en).toMatch(/new/i); // NURTURE default
  });

  it('clamps an out-of-range send-hour into 0..23', () => {
    expect(draftCampaign(sheet({ send_hour: 99 })).send_hour).toBe(23);
    expect(draftCampaign(sheet({ send_hour: -5 })).send_hour).toBe(0);
  });

  it('weaves a featured offer into the copy when provided', () => {
    const d = draftCampaign(sheet({ top_offer: 'Signature Latte' }));
    expect(d.offer_th).toContain('Signature Latte');
    expect(d.offer_en).toContain('Signature Latte');
  });

  it('is deterministic — same facts, same draft', () => {
    expect(draftCampaign(sheet())).toEqual(draftCampaign(sheet()));
  });
});

describe('draftVariantB (docs/62 Phase 3 A/B)', () => {
  it('is a REAL creative contrast — offer-first framing, different from variant A', () => {
    const a = draftCampaign(sheet());
    const b = draftVariantB(sheet());
    expect(b.body_th).not.toBe(a.body_th);
    expect(b.subject_th).not.toBe(a.subject_th);
    expect(b.subject_th).toContain('ส่วนลด 20%');       // leads with the WINBACK offer
    expect(b.subject_en).toMatch(/just for you/i);
  });
  it('weaves the featured offer in and stays deterministic', () => {
    const b1 = draftVariantB(sheet({ top_offer: 'Signature Latte' }));
    expect(b1.body_th).toContain('Signature Latte');
    expect(b1).toEqual(draftVariantB(sheet({ top_offer: 'Signature Latte' })));
  });
});

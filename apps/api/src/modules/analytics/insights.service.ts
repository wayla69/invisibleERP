import { Injectable } from '@nestjs/common';
import { llmClient } from '../../common/llm-client';
import type { Prediction } from './forecasting.service';
import { modelFor, aiDpaBlocked } from '../../common/ai-models';

/**
 * LLM insights — port จาก analytics/llm_insights.py
 * ไม่มี ANTHROPIC_API_KEY → rule-based fallback ทันที (Thai). มี key → เรียก Claude, error → fallback.
 */
@Injectable()
export class InsightsService {
  private get apiKey() { return aiDpaBlocked() ? '' : (process.env.ANTHROPIC_API_KEY || ''); } // gated → rule-based
  private get model() { return modelFor('insight'); } // analytics narrative → REASONING tier (was Opus)

  async replenishment(pred: Prediction): Promise<string> {
    if (!this.apiKey) return ruleRepl(pred);
    const prompt = `คุณเป็น ERP inventory analyst ของบริษัทกระจายอาหารไทย วิเคราะห์ข้อมูลนี้แล้วให้คำแนะนำสั้น กระชับ ปฏิบัติได้จริง เป็นภาษาไทย (2-3 ประโยค) เน้น urgency/action/quantity ตอบเป็นภาษาไทยเท่านั้น:\n${JSON.stringify(pred, null, 2)}`;
    return this.call(prompt, 300, () => ruleRepl(pred));
  }

  async anomaly(a: any): Promise<string> {
    if (!this.apiKey) return ruleAnom(a);
    const prompt = `คุณเป็นนักวิเคราะห์ป้องกันการสูญเสีย (fraud/loss prevention) ของบริษัทกระจายอาหารไทย วิเคราะห์ความผิดปกตินี้ ตอบเป็นภาษาไทยเท่านั้น เน้นเกิดอะไร/ความรุนแรง/การกระทำ:\n${JSON.stringify(a, null, 2)}`;
    return this.call(prompt, 300, () => ruleAnom(a));
  }

  async bulk(replList: Prediction[], anomalySummary: any): Promise<string> {
    const criticalRepl = replList.filter((p) => p.urgency === 'critical').length;
    const criticalAnom = anomalySummary?.critical_count ?? 0;
    if (!this.apiKey) return ruleBulk(replList.length, criticalRepl, anomalySummary?.total_anomalies ?? 0, criticalAnom);
    const topCritical = replList.filter((p) => p.urgency === 'critical').slice(0, 3).map((p) => p.item_name);
    const prompt = `สรุปภาพรวม ERP analytics สำหรับผู้จัดการธุรกิจอาหารไทย 2 ประโยค เป็นภาษาไทย: สินค้าต้องสั่งซื้อ ${replList.length} รายการ (วิกฤต ${criticalRepl}), ความผิดปกติ ${anomalySummary?.total_anomalies ?? 0} (วิกฤต ${criticalAnom}). รายการวิกฤตเด่น: ${topCritical.join(', ')}`;
    return this.call(prompt, 200, () => ruleBulk(replList.length, criticalRepl, anomalySummary?.total_anomalies ?? 0, criticalAnom));
  }

  private async call(prompt: string, maxTokens: number, fallback: () => string): Promise<string> {
    try {
      const client = llmClient(this.apiKey); // provider seam (docs/24 R4-4) — retries/backoff live inside
      const msg = await client.create({ model: this.model, max_tokens: maxTokens, messages: [{ role: 'user', content: prompt }] });
      const block = msg.content?.[0];
      return (block?.type === 'text' ? block.text : '').trim() || fallback();
    } catch {
      return fallback(); // network/key/model error → fallback เงียบ (parity)
    }
  }
}

// ── rule-based fallbacks (Thai + emoji — parity เป๊ะ) ──
function ruleRepl(p: Prediction): string {
  const name = p.item_name, days = Math.round(p.days_of_stock ?? 0), lt = p.lead_time_days, reorder = Math.round(p.reorder_point), avg = (p.avg_daily_sales ?? 0).toFixed(1);
  if (p.urgency === 'critical') return `⚠️ **${name}** มีสต๊อกวิกฤต! คาดว่าจะหมดใน ${days} วัน แต่ Lead Time ของ Supplier คือ ${lt} วัน — ควรสั่งซื้อทันที (Reorder Point: ${reorder} หน่วย, ยอดขายเฉลี่ย ${avg} หน่วย/วัน)`;
  if (p.urgency === 'warning') return `⚡ **${name}** ควรพิจารณาสั่งซื้อเร็วๆ นี้ สต๊อกเหลือประมาณ ${days} วัน (Lead Time: ${lt} วัน) Reorder Point แนะนำ: ${reorder} หน่วย`;
  return `✅ **${name}** สต๊อกเพียงพอ ยังไม่จำเป็นต้องสั่งซื้อ`;
}
function ruleAnom(a: any): string {
  return `🔴 ตรวจพบความผิดปกติ: **${a.item_name}** มี ${a.movement_type} สูงผิดปกติ (${Number(a.recent_qty).toFixed(1)} หน่วย เทียบกับค่าเฉลี่ยปกติ ${Number(a.hist_avg).toFixed(1)} หน่วย, Z-score: ${Number(a.z_score).toFixed(1)}) — แนะนำตรวจสอบและขออนุมัติหากจำเป็น`;
}
function ruleBulk(replCount: number, criticalRepl: number, anomCount: number, criticalAnom: number): string {
  const parts: string[] = [];
  if (replCount > 0) parts.push(`⚠️ มีสินค้า ${replCount} รายการที่ต้องสั่งซื้อด่วน`);
  if (criticalAnom > 0) parts.push(`🔴 พบความผิดปกติร้ายแรง ${criticalAnom} รายการ ควรตรวจสอบทันที`);
  if (!parts.length) parts.push('✅ สต๊อกสินค้าและการเคลื่อนไหวอยู่ในระดับปกติ');
  return parts.join(' | ');
}

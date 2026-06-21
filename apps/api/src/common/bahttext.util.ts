// จำนวนเงิน (บาท) → ข้อความภาษาไทย เช่น 1337.5 → "หนึ่งพันสามร้อยสามสิบเจ็ดบาทห้าสิบสตางค์".
// ใช้ dependency `bahttext`; ถ้าโหลดไม่ได้ fallback เป็นตัวเลข + "บาทถ้วน".
export function bahtText(amount: number): string {
  const x = Number(amount) || 0;
  try {
    // bahttext exports the function directly (module.exports = bahttext)
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const mod = require('bahttext');
    const fn = typeof mod === 'function' ? mod : mod.bahttext ?? mod.default;
    return fn(x);
  } catch {
    const money = x.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    return `${money} บาทถ้วน`;
  }
}

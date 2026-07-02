// นโยบายความเป็นส่วนตัว (docs/24 R0-2) — a server-rendered summary of docs/legal/privacy-policy.md so the
// signup flow has a public target. DRAFT until counsel publishes the full policy; keep in sync with the doc.
import Link from 'next/link';

export const metadata = { title: 'นโยบายความเป็นส่วนตัว — Invisible ERP' };

export default function PrivacyPolicyPage() {
  return (
    <main className="mx-auto max-w-3xl px-6 py-12 text-sm leading-relaxed">
      <h1 className="text-2xl font-semibold">นโยบายความเป็นส่วนตัว / Privacy Policy</h1>
      <p className="mt-1 text-muted-foreground">
        ฉบับร่าง (DRAFT) — มีผลเมื่อได้รับการตรวจทานทางกฎหมายและประกาศใช้ · กรอบกฎหมาย: พ.ร.บ.คุ้มครองข้อมูลส่วนบุคคล พ.ศ. 2562 (PDPA)
      </p>

      <h2 className="mt-8 text-lg font-semibold">เราเก็บข้อมูลอะไร</h2>
      <p className="mt-2">
        ข้อมูลบัญชีผู้ใช้และการเข้าสู่ระบบ ข้อมูลการเรียกเก็บเงิน (ไม่เก็บหมายเลขบัตร — ผู้ให้บริการชำระเงินเป็นผู้ประมวลผล)
        และข้อมูลธุรกิจที่ลูกค้านำเข้าระบบ ซึ่งลูกค้าเป็นผู้ควบคุมข้อมูลและเราประมวลผลตามข้อตกลงการประมวลผลข้อมูล (DPA)
      </p>

      <h2 className="mt-6 text-lg font-semibold">การปกป้องข้อมูล (ตามที่ระบบสร้างมา)</h2>
      <ul className="mt-2 list-disc space-y-1 pl-6">
        <li>แยกข้อมูลระหว่างผู้เช่า (tenant) ด้วย Row-Level Security บังคับที่ฐานข้อมูล</li>
        <li>เข้ารหัสข้อมูลอ่อนไหวที่จัดเก็บ (AES-256-GCM): เลขบัตรประชาชน/ผู้เสียภาษี เลขประกันสังคม บัญชีธนาคาร</li>
        <li>บันทึกตรวจสอบแบบต่อท้ายอย่างเดียว (hash-chained) — รายการบัญชีที่ผ่านรายการแล้วแก้ไขไม่ได้</li>
        <li>ฟีเจอร์ AI เป็นทางเลือก: ปกปิดข้อมูลติดต่อส่วนบุคคลก่อนส่งถึงผู้ให้บริการโมเดล และไม่ใช้ข้อมูลลูกค้าฝึกโมเดล</li>
      </ul>

      <h2 className="mt-6 text-lg font-semibold">สิทธิของเจ้าของข้อมูล (PDPA)</h2>
      <p className="mt-2">
        ขอเข้าถึง แก้ไข ลบ โอนย้าย หรือคัดค้านการประมวลผลได้ ระบบมีเวิร์กโฟลว์ DSAR ตามกรอบเวลา 30 วัน
        การลบจะปกปิดข้อมูลส่วนบุคคลโดยคงหลักฐานทางการเงินที่กฎหมายกำหนดไว้
      </p>

      <h2 className="mt-6 text-lg font-semibold">ผู้ประมวลผลช่วง</h2>
      <p className="mt-2">Alibaba Cloud (โฮสติ้ง/ฐานข้อมูล) · Stripe (ชำระเงิน) · Anthropic (AI — ทางเลือก) · Sentry (มอนิเตอริง)</p>

      <p className="mt-8 text-muted-foreground">
        ฉบับเต็ม (อังกฤษ): <code>docs/legal/privacy-policy.md</code> · ข้อกำหนดการใช้บริการและ DPA อยู่ใน <code>docs/legal/</code>
      </p>
      <p className="mt-4">
        <Link href="/signup" className="text-primary hover:underline">← กลับไปสมัครใช้งาน</Link>
      </p>
    </main>
  );
}

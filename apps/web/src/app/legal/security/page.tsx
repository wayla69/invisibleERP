// ความปลอดภัยและความน่าเชื่อถือ (Trust & Security) — a server-rendered, customer-facing summary of
// docs/security/trust-center.md, so the signup/marketing flow has a public "trust center" target that
// answers the "is my data safe / are you reliable" objection with concrete, code-backed controls.
// Keep in sync with docs/security/trust-center.md. Honesty position: controls are BUILT + auto-tested;
// external attestation (SOC 2 Type I) is on the roadmap, NOT yet certified — do not overclaim here.
import Link from 'next/link';

export const metadata = {
  title: 'ความปลอดภัยและความน่าเชื่อถือ — Invisible ERP',
  description: 'สรุปมาตรการความปลอดภัย ความเป็นส่วนตัว และความน่าเชื่อถือของระบบ Invisible ERP',
};

function Section({ th, en, children }: { th: string; en: string; children: React.ReactNode }) {
  return (
    <section className="mt-8">
      <h2 className="text-lg font-semibold">
        {th} <span className="text-muted-foreground">/ {en}</span>
      </h2>
      <ul className="mt-2 list-disc space-y-1.5 pl-6">{children}</ul>
    </section>
  );
}

export default function SecurityTrustPage() {
  return (
    <main className="mx-auto max-w-3xl px-6 py-12 text-sm leading-relaxed">
      <h1 className="text-2xl font-semibold">ความปลอดภัยและความน่าเชื่อถือ / Security &amp; Trust</h1>
      <p className="mt-2 text-muted-foreground">
        ความปลอดภัยและความเสถียรของระบบไม่ใช่คำโฆษณา แต่เป็นการควบคุมที่ถูกออกแบบไว้ในระบบ บังคับที่ระดับฐานข้อมูล
        และถูกทดสอบซ้ำโดยอัตโนมัติทุกครั้งที่มีการเปลี่ยนแปลงโค้ด — Security and reliability here are engineered
        controls, database-enforced, and re-tested automatically on every change.
      </p>

      <div className="mt-5 rounded-lg border border-border bg-muted/40 p-4">
        <p className="font-medium">จุดยืนเรื่องความโปร่งใส / Our honesty position</p>
        <p className="mt-1 text-muted-foreground">
          เราไม่กล่าวอ้างว่า “ได้รับการรับรองจากผู้ตรวจสอบภายนอกแล้ว” ในวันนี้ สิ่งที่เป็นจริงและตรวจสอบได้คือ
          การควบคุมด้านล่างถูกสร้างไว้ในผลิตภัณฑ์และทดสอบซ้ำอัตโนมัติ และระบบผ่านการทดสอบเจาะระบบ (penetration test)
          และทดสอบโหลดจากภายนอกแล้ว การรับรอง SOC 2 Type I อยู่ในแผนงานที่กำลังดำเนินการ (ดูหัวข้อสุดท้าย) —
          We do not claim external certification today; the controls below are built-in and auto-tested, the
          system has passed an independent pen-test and load-test, and SOC 2 Type I attestation is an active
          roadmap item.
        </p>
      </div>

      <Section th="ข้อมูลของคุณถูกแยกจากลูกค้ารายอื่น" en="Your data is isolated from every other customer">
        <li>แยกข้อมูลระหว่างผู้เช่า (tenant) ด้วย Row-Level Security ที่บังคับใช้ในฐานข้อมูล PostgreSQL เอง ไม่ใช่แค่ในโค้ดแอป</li>
        <li>ออกแบบให้ “ปฏิเสธเมื่อไม่แน่ใจ” (fails closed): หากตั้งขอบเขตผู้เช่าไม่ได้ ระบบจะปฏิเสธคำขอ ไม่ยอมให้ข้อมูลรั่ว</li>
        <li>ผ่านการทดสอบเจาะระบบจริง (2026-06-28) ยืนยันว่าการอ่าน/เขียนข้ามผู้เช่าถูกบล็อก — รายงานระบุว่าเป็น “ส่วนที่แข็งแรงที่สุดของระบบ”</li>
      </Section>

      <Section th="ควบคุมการเข้าถึง โดยเฉพาะสิทธิ์ระดับสูง" en="Access control, with privileged access protected">
        <li>บังคับยืนยันตัวตนสองปัจจัย (MFA/TOTP) สำหรับบทบาทระดับสูง การเงิน และผู้ดูแลสิทธิ์</li>
        <li>รหัสผ่านถูกแฮชด้วย scrypt (พารามิเตอร์เข้มงวด) เปรียบเทียบแบบ constant-time — ไม่เก็บในรูปที่ถอดกลับได้</li>
        <li>เพิกถอนเซสชันได้ทันที (token มี jti + denylist และ watermark) — การเปลี่ยนสิทธิ์มีผลทันที ไม่ต้องรอ token หมดอายุ</li>
        <li>Refresh token หมุนเวียนแบบใช้ครั้งเดียว พร้อมตรวจจับการขโมย token</li>
        <li>สิทธิ์แบบละเอียด (RBAC ~60 สิทธิ์) และการแบ่งแยกหน้าที่ (SoD) 16 กฎ ป้องกันคนเดียวถือทั้งสองด้านของงานที่ขัดกัน</li>
        <li>รองรับ SSO ระดับองค์กร (OIDC + PKCE) และการจัดสรรผู้ใช้อัตโนมัติ (SCIM)</li>
      </Section>

      <Section th="เข้ารหัสข้อมูลและป้องกันอินพุต" en="Data is encrypted and inputs are defended">
        <li>เข้ารหัสข้อมูลอ่อนไหวที่จัดเก็บด้วย AES-256-GCM (เลขบัตร/ผู้เสียภาษี บัญชีธนาคาร กุญแจ MFA/การเชื่อมต่อ) และ TLS ระหว่างส่ง</li>
        <li>เสริมความแข็งแรง: security headers (helmet/CSP), CORS allow-list, ป้องกัน CSRF, จำกัดอัตราการเรียก และตรวจสอบอินพุต (Zod)</li>
        <li>ต้านทาน SQL injection โดยการออกแบบ — เข้าถึงฐานข้อมูลผ่าน query builder ที่ผูกพารามิเตอร์ (Drizzle ORM)</li>
      </Section>

      <Section th="ตรวจสอบย้อนหลังได้และตรวจจับการแก้ไขได้" en="Auditable and tamper-evident">
        <li>บันทึกตรวจสอบแบบต่อท้ายอย่างเดียว ผูกกันด้วย hash chain (SHA-256) — ตรวจจับการแก้ไขประวัติได้; trigger ระดับฐานข้อมูลห้ามแก้/ลบ</li>
        <li>ควบคุมแบบ maker-checker: รายการบัญชี/เงินเดือน/การจับคู่ 3 ทาง ต้องมีผู้อนุมัติคนละคนจากผู้บันทึก</li>
      </Section>

      <Section th="ความปลอดภัยถูกบังคับในกระบวนการสร้างซอฟต์แวร์" en="Security enforced in the build pipeline">
        <li>วิเคราะห์โค้ดอัตโนมัติ (CodeQL SAST), สแกน dependency (pnpm audit เป็นด่านบังคับ), สแกนความลับ (gitleaks), ตรวจ license</li>
        <li>ผ่านการตรวจสอบ + ทดสอบเจาะระบบ + ทดสอบโหลดจากภายนอก (2026-06-28); ข้อค้นพบระดับสูงสุด (การหุ้ม SSO callback,
          การล็อกบัญชีเมื่อเข้าสู่ระบบผิดซ้ำ, ช่องยกระดับสิทธิ์ผ่านการมอบ Admin) ได้รับการแก้ไขในโค้ดแล้ว</li>
      </Section>

      <Section th="ความน่าเชื่อถือถูกออกแบบและวัดผล" en="Reliability is engineered and measured">
        <li>โค้ดเบสมีชุดทดสอบอัตโนมัติจำนวนมาก (ราว 100 integration harness) ที่บูตแอปจริงกับฐานข้อมูลจริงทุกการเปลี่ยนแปลง</li>
        <li>ทดสอบโหลดถึง 200 เซสชันพร้อมกันโดยไม่มี error และเสื่อมสภาพอย่างนุ่มนวลเมื่อรับโหลดสูง (ไม่ล่ม); รองรับการขยายแบบหลายโปรเซส</li>
        <li>สำรองข้อมูลรายชั่วโมงพร้อมตรวจสอบการกู้คืนและสำเนานอกสถานที่ (RPO ≈ 1 ชม., RTO &lt; 30 นาที) และซ้อมกู้ภัย (DR game-day)</li>
        <li>เฝ้าสังเกตระบบ: structured logging, OpenTelemetry, Sentry และ health/readiness endpoints</li>
      </Section>

      <Section th="การปฏิบัติตามข้อกำหนดและการรับรองภายนอก" en="Compliance & external attestation">
        <li>ระบบควบคุมภายในด้านการเงิน (SOX/ICFR): เมทริกซ์ความเสี่ยง-การควบคุม 184 รายการ (ทำแล้ว 181) ทดสอบประสิทธิผลอัตโนมัติทุก CI</li>
        <li>ชุดนโยบาย 13 ฉบับ (ความมั่นคงปลอดภัยสารสนเทศ การเข้าถึง SoD การจัดการการเปลี่ยนแปลง การตอบสนองเหตุการณ์ สำรอง/กู้ภัย ฯลฯ)</li>
        <li>รองรับ PDPA พร้อมเวิร์กโฟลว์ DSAR 30 วัน; ฟีเจอร์ AI ปกปิดข้อมูลติดต่อก่อนส่งโมเดล และไม่ใช้ข้อมูลลูกค้าฝึกโมเดล</li>
        <li>อยู่ระหว่างดำเนินการ (ยังไม่รับรอง): SOC 2 Type I เป็นเป้าหมายแรก พร้อมการวิเคราะห์ช่องว่าง ISO 27001 และ PCI-DSS ที่ร่างไว้แล้ว</li>
      </Section>

      <p className="mt-8 text-muted-foreground">
        ขอเอกสารเพิ่มเติมได้ (บางส่วนภายใต้ NDA): รายงานทดสอบเจาะระบบ/โหลด, ชุดนโยบายและเมทริกซ์การควบคุม,
        แบบสอบถามความปลอดภัยผู้ขาย (SIG-lite/CAIQ), ข้อตกลงประมวลผลข้อมูล (DPA) และรายชื่อผู้ประมวลผลช่วง, สถานะ SOC 2.
        {' '}ดู{' '}
        <Link href="/legal/privacy" className="underline hover:text-primary">
          นโยบายความเป็นส่วนตัว
        </Link>{' '}
        · ฉบับเต็ม: <code>docs/security/trust-center.md</code>
      </p>
    </main>
  );
}

# Invisible ERP — Customer Presentation

ชุดนำเสนอระบบ Invisible ERP สำหรับลูกค้า — **สองภาษา (ไทย/อังกฤษ) × สองรูปแบบ** จากเนื้อหาชุดเดียวกัน
ธีมพื้นขาวโทนพาสเทล ฟอนต์ **IBM Plex Sans Thai** ภาษาทางการระดับองค์กร

| ไฟล์ | ภาษา | รูปแบบ |
|------|------|--------|
| `output/Invisible-ERP-Presentation-TH.pptx` | ไทย | สไลด์ 16:9 (พื้นขาว พาสเทล) 83 หน้า |
| `output/Invisible-ERP-Presentation-EN.pptx` | อังกฤษ | สไลด์ 16:9 (พื้นขาว พาสเทล) 83 หน้า |
| `output/Invisible-ERP-Whitepaper-TH.pdf` | ไทย | เอกสาร A4 แนวตั้ง สไตล์ whitepaper |
| `output/Invisible-ERP-Whitepaper-EN.pdf` | อังกฤษ | เอกสาร A4 แนวตั้ง สไตล์ whitepaper |

## โครงสร้างเนื้อหา

- **0. ภาพรวมระบบ** — Invisible ERP คืออะไร, ตัวเลข, 4 surface, คุณค่าธุรกิจ
- **1. จุดที่เหนือกว่า** — 9 จุดต่าง, ตารางเทียบ, ทำไมลอกยาก
- **2. ความปลอดภัยและการควบคุม** — multi-tenant RLS, OWASP, SOX/ICFR + RCM, ITGC/compliance
- **3. โมดูลใน POS** — แผนที่โมดูลฝั่งหน้าร้าน
- **4. โมดูลใน ERP** — แผนที่โมดูลฝั่งหลังบ้าน
- **5. เจาะลึกแต่ละโมดูล** — 26 โดเมน พร้อม control ID, SoD, จุดเด่น, หน้าจอ
- **6. ข้อควรพิจารณาเพิ่มเติม** — onboarding, สถาปัตยกรรม, แพ็กเกจ, ระบบนิเวศ, สรุป

## โครงไฟล์

```
content.py            # เนื้อหาสองภาษาทั้งหมด — ทุกข้อความห่อด้วย T("<ไทย>","<อังกฤษ>"); set_lang('th'|'en')
pptx_lib.py           # helper วาดสไลด์ (ธีมพาสเทลพื้นขาว) + ตัวฝังฟอนต์
slides.py             # เทมเพลตสไลด์ (cover/divider/cards/module-deepdive/compare/…)
build_pptx.py         # สร้าง PPTX แบบ native (แก้ข้อความได้ — ใช้เป็นตัวตั้งต้นของ build_pptx_images.py)
build_pptx_images.py  # ★ สร้าง PPTX ที่ "เปิดได้ทุกเครื่อง" — เรนเดอร์แต่ละสไลด์เป็นรูป (pixel-perfect)
build_pdf.py          # สร้าง PDF whitepaper (reportlab)
fonts/                # IBM Plex Sans Thai (+ Kanit/Sarabun เดิม) — OFL, vendored เพื่อ reproduce ได้
assets/               # โลโก้ Invisible Consulting (เวอร์ชันขาว/ดำ พื้นโปร่งใส)
output/               # ไฟล์ผลลัพธ์
```

## วิธีสร้างใหม่

```bash
pip install python-pptx reportlab
cd presentation
# ต้องมี libreoffice-impress + poppler-utils (สำหรับ build_pptx_images.py)
for L in th en; do
  python3 build_pptx_images.py "output/Invisible-ERP-Presentation-${L^^}.pptx" $L
  python3 build_pdf.py         "output/Invisible-ERP-Whitepaper-${L^^}.pdf"     $L
done
```

แก้เนื้อหาที่ `content.py` (ทั้งไทยและอังกฤษอยู่บรรทัดเดียวกันใน `T(...)`) แล้ว build ใหม่ — ทุกไฟล์อัปเดตพร้อมกัน

> **ทำไม PPTX ถึงเป็น image-based:** สไลด์แบบ native (เงา/ความโปร่งใส/ฝังฟอนต์) LibreOffice เปิดได้ แต่
> **PowerPoint โดยเฉพาะบนมือถือตรวจ OOXML schema เข้มกว่าและปฏิเสธการเปิด** `build_pptx_images.py` จึง
> เรนเดอร์แต่ละสไลด์เป็นรูปความละเอียดสูง (2000px) แล้วประกอบเป็น PPTX ที่มีแต่ `<p:pic>` — เปิดได้ทุกเครื่อง
> หน้าตาเป๊ะตามดีไซน์ (ข้อแลกเปลี่ยน: แก้ข้อความในตัวไม่ได้ ต้องแก้ `content.py` แล้ว build ใหม่)

## โลโก้ในแอป (ไม่ hardcode)

อัปโหลดผ่าน **`/setup`** (Branding — โลโก้/tagline บนใบเสร็จ/หัวเอกสาร) และ/หรือ **`/theme`** (white-label
สี+โลโก้ทั้งแอป) เก็บต่อ tenant ใน `tenant_ui_config` จึงไม่กระทบบริษัทอื่น ใช้ไฟล์ `assets/invisible-consulting-logo-dark.png`

## หมายเหตุ

- ตัวเลข/ข้อเท็จจริงดึงจากเอกสารจริงในโปรเจกต์ (`docs/process-narratives/`, `docs/user-manual/`, `compliance/`)
  เช่น RCM 282 controls, 23 SoD rules (R01–R23), 22 security findings ที่แก้แล้ว
- ฟอนต์: IBM Plex Sans Thai (SIL Open Font License) — ครอบคลุมทั้งไทยและอังกฤษ, redistribute ได้

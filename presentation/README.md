# Invisible ERP — Customer Presentation

ชุดนำเสนอระบบ Invisible ERP สำหรับลูกค้า (ภาษาไทย) — สร้างเป็น **2 รูปแบบจากเนื้อหาชุดเดียวกัน**:

| ไฟล์ | รูปแบบ | รายละเอียด |
|------|--------|-----------|
| `output/Invisible-ERP-Presentation.pptx` | สไลด์ 16:9 ธีมมืดพรีเมียม | 84 หน้า, ฝัง font ไทย (Kanit/Sarabun) ในไฟล์ → เปิดที่เครื่องไหนก็ได้ |
| `output/Invisible-ERP-Whitepaper.pdf` | เอกสาร A4 แนวตั้ง สไตล์ whitepaper | 41 หน้า, เลย์เอาต์แบบเอกสารไหลต่อเนื่อง |

## โครงสร้างเนื้อหา (ตามที่ลูกค้าขอ)

- **0. ภาพรวมระบบ** (5 หน้า) — Invisible ERP คืออะไร, ตัวเลข, 4 surface, คุณค่าธุรกิจ
- **1. สิ่งที่มีแต่ที่อื่นไม่มี** (3 หน้า) — 9 จุดต่าง, ตารางเทียบ, ทำไมลอกยาก
- **2. ระบบความปลอดภัย** (5 หน้า) — multi-tenant RLS, OWASP, SOX/ICFR + RCM, ITGC/compliance
- **3. โมดูลใน POS** (2 หน้า) — แผนที่โมดูลฝั่งหน้าร้านทั้งหมด
- **4. โมดูลใน ERP** (3 หน้า) — แผนที่โมดูลฝั่งหลังบ้านทั้งหมด
- **5. เจาะลึกแต่ละโมดูล** (50 หน้า) — 26 โดเมน พร้อม control ID, SoD, จุดเด่น, หน้าจอ
- **6. สิ่งที่ควรรู้เพิ่มเติม** (8 หน้า) — onboarding, สถาปัตยกรรม, แพ็กเกจ, ระบบนิเวศ, สรุป

## โครงไฟล์

```
content.py      # เนื้อหาทั้งหมด (spec ที่ทั้ง 2 generator ใช้ร่วมกัน) — แก้ที่นี่ที่เดียว
pptx_lib.py     # helper วาดสไลด์ + ฝัง font ลง .pptx
slides.py       # เทมเพลตสไลด์ (cover/divider/cards/module-deepdive/compare/…)
build_pptx.py   # สร้าง PPTX (ธีมมืด)
build_pdf.py    # สร้าง PDF whitepaper (ธีมสว่าง, reportlab)
fonts/          # Kanit + Sarabun (OFL) — vendored เพื่อ reproduce ได้
assets/         # โลโก้ Invisible Consulting (เวอร์ชันขาว/ดำ พื้นโปร่งใส)
output/         # ไฟล์ผลลัพธ์
```

## โลโก้ (Invisible Consulting)

โลโก้ผู้พัฒนาอยู่ที่ `assets/` แยกเป็น 2 เวอร์ชัน (พื้นโปร่งใส):
- `invisible-consulting-logo-white.png` — พื้นมืด (cover/divider/closing ของ PPTX, cover/section band ของ PDF)
- `invisible-consulting-logo-dark.png` — พื้นสว่าง (closing ของ PDF, อัปโหลดในแอป)

**การใช้โลโก้ในแอป (ไม่ hardcode):** อัปโหลดผ่าน **`/setup`** (Branding — โลโก้/tagline แสดงบนใบเสร็จ/หัวเอกสาร)
และ/หรือ **`/theme`** (white-label สี+โลโก้ทั้งแอป) — เก็บต่อ tenant ใน `tenant_ui_config` จึงไม่กระทบบริษัทอื่น

## วิธีสร้างใหม่

```bash
pip install python-pptx reportlab
cd presentation
python3 build_pptx.py output/Invisible-ERP-Presentation.pptx
python3 build_pdf.py  output/Invisible-ERP-Whitepaper.pdf
```

แก้เนื้อหาที่ `content.py` แล้ว build ใหม่ — ทั้ง PPTX และ PDF จะอัปเดตพร้อมกัน

## หมายเหตุ

- ตัวเลข/ข้อเท็จจริงในสไลด์ดึงจากเอกสารจริงในโปรเจกต์ (`docs/process-narratives/`, `docs/user-manual/`,
  `compliance/`) เช่น RCM 282 controls, 23 SoD rules (R01–R23), 22 security findings ที่แก้แล้ว
- Font: Kanit + Sarabun (SIL Open Font License) — redistribute ได้

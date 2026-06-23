# Presentations — งานนำเสนอ

งานนำเสนอสำหรับลูกค้า/ผู้มีส่วนได้ส่วนเสีย แยกจากเอกสารกระบวนการ (`docs/process-narratives/`)
และคู่มือผู้ใช้ (`docs/user-manual/`).

| ไฟล์ | ภาษา | กลุ่มเป้าหมาย | เนื้อหา |
|---|---|---|---|
| [`invisible-erp-customer-pitch-th.md`](./invisible-erp-customer-pitch-th.md) | ไทย | ลูกค้า / ผู้มีโอกาสซื้อ | ฟังก์ชันของระบบ และจุดเด่นเมื่อเทียบกับคู่แข่งในตลาด |

## วิธีนำเสนอ (render เป็นสไลด์)

ไฟล์เขียนในรูปแบบ **Marp** (Markdown → สไลด์) แต่ละสไลด์คั่นด้วย `---`

```bash
# ติดตั้ง Marp CLI แล้วแปลงเป็น PDF / PPTX / HTML
npx @marp-team/marp-cli docs/presentations/invisible-erp-customer-pitch-th.md --pdf
npx @marp-team/marp-cli docs/presentations/invisible-erp-customer-pitch-th.md --pptx
npx @marp-team/marp-cli docs/presentations/invisible-erp-customer-pitch-th.md --html
```

หรือเปิดดูแบบสไลด์ทันทีด้วยส่วนขยาย **Marp for VS Code** (พรีวิวในตัว)
ฟอนต์ไทยที่ใช้คือ **Sarabun / Noto Sans Thai** (มีในเครื่องส่วนใหญ่ และเป็นฟอนต์ที่ระบบใช้ออกเอกสาร PDF อยู่แล้ว)

> หมายเหตุ: เป็นเอกสารการตลาด/นำเสนอ — ไม่ได้แก้ไขโค้ดหรือลอจิกของแอป จึงไม่กระทบ
> control matrix, UAT หรือ RCM ตามนโยบาย doc-sync

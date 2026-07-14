# -*- coding: utf-8 -*-
"""All slide content (Thai) for the Invisible ERP customer deck, as generator-agnostic specs.
Both the PPTX (dark deck) and PDF (light whitepaper) builders consume this same list, so the
two deliverables carry identical content in two distinct visual systems.

accent keys: teal, cyan, violet, gold, green, coral
"""

# ══════════════════════════════════════════════════════════════════════════════
# SECTION 5 — module deep dives. Authored as (overview, controls) pairs or singles.
# ══════════════════════════════════════════════════════════════════════════════

def _deep_dive():
    S = []

    # 1 — POS & Restaurant (3 pages: overview, controls, extra offline/channels)
    S.append({"t":"mod_over","family":"POS · หน้าร้าน & ร้านอาหาร","accent":"cyan","glyph":"◧","tag":"FLAGSHIP",
        "title":"ระบบขายหน้าร้าน & บริหารร้านอาหารครบวงจร",
        "positioning":"POS ระดับ full-service สำหรับไทย — dine-in ระดับที่นั่ง, KDS, สั่งเอง QR + PromptPay, บุฟเฟต์, แยกบิล, เดลิเวอรี และ 'สมุดบัญชีภาษีที่แก้ไม่ได้' (hash-chain) ตามข้อกำหนดสรรพากร ทุกการปิดการขายลง GL อัตโนมัติแบบบาลานซ์",
        "features":[
            ("Dine-in ระดับที่นั่ง (POS-9)","สั่งแยกที่นั่ง/คอร์ส, fire by seat/course, รวมยอดต่อที่นั่ง, แยกบิลตามที่นั่ง — 'เลขบิลคือเลขที่นั่ง'"),
            ("Kitchen Display System","สถานะ new→preparing→ready→served, SLA aging เขียว/เหลือง/แดง, bump/recall, Expo + Station load"),
            ("สั่งเอง QR + PromptPay","สแกนโต๊ะ → เมนู + กลุ่ม modifier, day-parting, ราคาคำนวณฝั่ง server (ลูกค้าแก้ราคาไม่ได้), จ่าย EMVCo QR จริง"),
            ("ผังร้าน & โต๊ะ","ลากวางโต๊ะ/โซน VIP, ย้าย/รวม/โอนบิล, optimistic-lock กันชนกัน, รายงานยอดขายต่อห้อง"),
            ("บุฟเฟต์ & แยกบิล","ราคาต่อหัว + ค่าปรับเกินเวลา, แยกบิล equal/by-item/by-seat, N บิล = N GL = N ใบกำกับ"),
            ("โปรไฟล์ลูกค้า (allergy live)","เมนูโปรด/แพ้อาหาร/ที่นั่งโปรด — ธงแพ้อาหารขึ้นบนบอร์ด+ทุกตั๋วครัวแบบเรียลไทม์, ถอนความยินยอมแล้วหายทันที"),
        ]})
    S.append({"t":"mod_ctrl","family":"POS · หน้าร้าน & ร้านอาหาร","accent":"cyan",
        "title":"การควบคุมความถูกต้องเงินสด & กันทุจริตหน้าร้าน",
        "controls":[
            "REST-02 สมุดบัญชี fiscal แบบ hash-chain (SHA256 ต่อแถว) — แก้แถวเก่า = hash ทุกแถวถัดไปพัง ตรวจจับได้ทันจุด",
            "REST-01/GL-01 JE การขายบาลานซ์ + COGS ตามสูตร idempotent ต่อ sale_no",
            "REST-03 เพดานส่วนลด 50% (DISCOUNT_OVER_LIMIT) เกินต้องผู้จัดการกะอนุมัติ",
            "TIP-01 การแบ่งทิป (order_mgt/exec) แยกจากแคชเชียร์ (pos_sell) — จ่ายทิปให้ตัวเองไม่ได้",
            "REST-11 บันทึกการเปิดลิ้นชักทุกครั้ง + ธง no-sale, กระทบยอดกับ Z-report",
        ],
        "wow":[
            "สมุดภาษีแบบ cryptographic hash chain — ไม่ใช่แค่ log; การตรวจสอบชี้จุดที่ถูกแก้ไขได้แม่นยำ",
            "ลูกค้าสแกน–สั่ง–จ่ายเองครบ โดยไม่มีความเสี่ยงแก้ราคา (คำนวณฝั่ง server ทั้งหมด)",
            "ออฟไลน์ทำงานจริง — PWA ขายต่อได้ทั้ง quick-sale และ dine-in ขณะเน็ตล่ม, replay exactly-once",
            "ธงแพ้อาหารขึ้นสดบนทุกตั๋วครัว หายทันทีเมื่อถอนความยินยอม (PDPA)",
        ],
        "routes":["/pos/register","/kds","/tables","/pos/till","/buffet","/track/{token}"]})
    S.append({"t":"cards","kicker":"POS · ต่อ","title":"หลายสาขา · ออฟไลน์ · เดลิเวอรี · อุปกรณ์","accent":"cyan","cols":3,
        "section":"เจาะลึกแต่ละโมดูล",
        "cards":[
            ("⛁","PWA ขายออฟไลน์","ติดตั้งเป็นแอป ขายต่อได้ขณะเน็ตล่ม, idempotent ต่อ (tenant, client_uuid), replay เข้าคลาวด์แบบ exactly-once","cyan"),
            ("◉","LAN-first Store Hub","ฮับในร้านแบบ signed snapshot, ซิงก์ขาย/ทิ้ง/นับสต๊อกกลับคลาวด์ครั้งเดียวเป๊ะ","cyan"),
            ("⊞","รวมยอดหลายสาขา","HQ consolidation ข้ามสาขา, ยอดไม่ติดสาขาแสดง '(none)' เพื่อความครบถ้วน","teal"),
            ("⇆","เดลิเวอรีแอกกริเกเตอร์","Grab / LINE MAN / Foodpanda / Robinhood — webhook HMAC, sync เมนู, Auto-86 อัตโนมัติ","violet"),
            ("◫","ติดตามออเดอร์สาธารณะ","/track/{token} ไม่ต้องล็อกอิน — ไทม์ไลน์สด + จ่ายออนไลน์","violet"),
            ("⎙","อุปกรณ์ฮาร์ดแวร์","ESC/POS thermal, ลิ้นชักเงิน, จอลูกค้า, เครื่องชั่ง (คิดราคาฝั่ง server), e-Tax INET/Frank/Leceipt","gold"),
        ]})

    # 2 — Loyalty
    S.append({"t":"mod_over","family":"Loyalty · สมาชิก & แต้ม","accent":"gold","glyph":"★","tag":"LINE-NATIVE",
        "title":"ระบบสมาชิก & Loyalty ที่ผูกบัญชี GL จริง",
        "positioning":"โปรแกรมสมาชิกที่ปลอดภัยต่อ concurrency, ลงบัญชีตาม TFRS-15, มี LINE OA เป็นแกนตัวตน, ครบทั้ง missions/referral/กงล้อ/tier/journey, coalition แฟรนไชส์ และแอปสมาชิก — 'แต้ม' คือ sub-ledger ผูกกับ GL 2250 Loyalty Points Liability",
        "features":[
            ("แต้ม & tier ปลอดภัย","earn/redeem ใต้ FOR UPDATE ไม่มีแต้มหาย, tier auto-recompute + ประวัติ, tier journey แสดงแต้มถึงขั้นถัดไป"),
            ("ของรางวัล & missions","evoucher/discount/product/privilege, stamp card, member-get-member รางวัลครั้งเดียว"),
            ("กงล้อเสี่ยงโชค (provably fair)","สุ่มถ่วงน้ำหนักฝั่ง server แบบ cryptographic — ลูกค้าแทรกแซงไม่ได้, กันสต๊อกรางวัลติดลบ"),
            ("Campaign & Journey","broadcast ตาม RFM/tier/วันเกิด, claim-first at-most-once, เคารพ consent + quiet hours"),
            ("Coalition แฟรนไชส์ (LYL-19)","สะสม/ใช้แต้มข้ามแบรนด์ — ลงบัญชี intercompany clearing (1150/2150) แบบ atomic ที่มูลค่ายุติธรรม"),
            ("NPS ปิดลูป (LYL-20)","survey หลังซื้อไม่มี PII ใน URL — detractor (≤6) เปิด recovery case SLA 24 ชม.อัตโนมัติ"),
        ]})
    S.append({"t":"mod_ctrl","family":"Loyalty · สมาชิก & แต้ม","accent":"gold",
        "title":"แต้ม = หนี้สินที่ลงบัญชี ไม่ใช่ตัวเลขลอย",
        "controls":[
            "MKT-03 earn/redeem ปลอดภัย concurrency; config มูลค่าแต้มแยกจากพนักงานหน้าร้าน",
            "MKT-06 accrual หนี้สินแต้มอัตโนมัติ idempotent + de-recognition breakage",
            "LYL-17 อัปโหลดใบเสร็จรับแต้ม maker-checker + กันซ้ำ (DUPLICATE_RECEIPT)",
            "G13/R15 โอนแต้ม > 500 pts staged PendingApproval, ปล่อยโดยคนละคน (SOD_VIOLATION)",
            "PDPA member_consents ต่อวัตถุประสงค์ — ทุก broadcast บังคับ consent + frequency cap",
        ],
        "wow":[
            "แต้มเป็นหนี้สินที่ลง GL 2250 ด้วย TFRS-15 provision, accrual/breakage อัตโนมัติที่ปิดงวด",
            "Coalition แฟรนไชส์ — สะสม/ใช้ที่ไหนก็ได้ พร้อม intercompany clearing entry ที่บาลานซ์เสมอ",
            "กงล้อ provably-fair — สุ่มฝั่ง server ที่พิสูจน์ได้, ทุกครั้งบันทึกไว้",
            "คะแนน NPS แย่กลายเป็น recovery case มี SLA 24 ชม. — ไม่มีทางหายเงียบ",
            "LINE ครบวงจร — สมัคร/ล็อกอิน LIFF/e-receipt flex/wallet pass",
        ],
        "routes":["/loyalty","/loyalty/members/:id","/loyalty/journeys","/loyalty/receipt-approvals","/m"]})

    # 3 — CRM & Pipeline & CPQ
    S.append({"t":"mod_over","family":"CRM · ไปป์ไลน์ & CPQ","accent":"violet","glyph":"◎","tag":None,
        "title":"CRM + ขาย + บริการหลังการขาย บนแกนเดียว",
        "positioning":"แพลตฟอร์มขาย-บริการบนแกน opportunity เดียว: kanban pipeline, lead-to-cash ที่คุมได้, CPQ ที่บังคับ margin floor และ workspace หลังการขาย (SLA/warranty/case) — ปิดช่อง 'CRM ไม่เห็นเงิน' ด้วย Customer 360 ที่รวมเครดิต/AR/ดีล/ใบเสนอราคา/loyalty",
        "features":[
            ("แกน opportunity เดียว (CRM-1)","ตารางเดียวเสิร์ฟ /crm + /pipeline, ทุกการเลื่อน stage เขียน history แบบ append-only, won/lost เป็น terminal"),
            ("CRM workspace (CRM-2)","kanban ลากวาง + list + saved filter, หน้า deal/account, timeline กิจกรรมรวม"),
            ("Lead ปริมาณมาก","import CSV/xlsx (dry-run), web-to-lead สาธารณะ (honeypot + rate limit), qualify→convert สร้างลูกค้า+opportunity"),
            ("Lead scoring & follow-up (CRM-4)","เกรด A–D อธิบายได้ (ไม่ใช่กล่องดำ), follow-up center ตาม SLA/rotting, digest รายวัน"),
            ("CPQ margin floor","quote คำนวณฝั่ง server, ยอมรับ = ลง JE บาลานซ์ (CPQ-WIN), bundle แตกเป็นบรรทัดต้นทุนจริง"),
            ("บริการหลังการขาย","service contract SLA (Bronze–Platinum), subscription billing, warranty/entitlement, support case + Email-to-Case"),
        ]})
    S.append({"t":"mod_ctrl","family":"CRM · ไปป์ไลน์ & CPQ","accent":"violet",
        "title":"ขายต่ำกว่าต้นทุนไม่ได้ถ้าไม่มีคนที่สองอนุมัติ",
        "controls":[
            "CPQ-01 margin floor maker-checker — ส่วนลด/มาร์จิ้นต่ำกว่าเกณฑ์ pending, ยอมรับไม่ได้จนคนละคนอนุมัติ",
            "CPQ-03/G12 ยอมรับใบเสนอราคา (ลงรายได้) ต้องคนละคนกับผู้เขียน (SOD_VIOLATION)",
            "R09/R10 credit master แยกจาก order entry; ราคา/ส่วนลด แยกจากการขาย",
            "SVC-01 การให้เคลมฟรีนอกประกันต้องผู้อนุมัติอิสระ; SVC-02 renewal เกินเพดาน maker-checker",
            "KB publish ต้องผู้เขียน ≠ ผู้เผยแพร่",
        ],
        "wow":[
            "ขายต่ำกว่า margin floor ไม่ได้ — quote ไปไม่ถึง Accepted จนผู้อนุมัติอิสระเคลียร์ (bundle ก็แอบลดไม่ได้)",
            "'CRM ที่เห็นเงิน' — Customer 360 รวมเครดิต/AR ค้าง/ดีล/quote/loyalty tier+NPS ในมุมมองก่อนโทร",
            "ตรวจสิทธิ์ประกันอัตโนมัติตอนเคลม — ในประกัน = ฟรีทันที, นอกประกัน = รออนุมัติ + log ทุกครั้ง",
            "แกนเดียว lead→opp→quote→AR→หลังการขาย บน customer-of-record เดียว มี stage history",
        ],
        "routes":["/crm","/crm/deals/{OPP}","/service","/service/warranty","/service/renewals","/cpq"]})

    # 4 — Marketing & Pricing & Promotions
    S.append({"t":"mod_over","family":"Marketing · ราคา & โปรโมชัน","accent":"coral","glyph":"◈","tag":None,
        "title":"ราคา & โปรโมชันที่ 'ไม่มีอะไรขึ้นใช้งานโดยไม่ผ่านการตรวจ'",
        "positioning":"การกำหนดราคา/ส่วนลดที่ทุกการเปลี่ยนเป็น maker-checker (staged inactive จนคนละคนเปิดใช้) และ engine อ่านเฉพาะกฎที่อนุมัติแล้ว — บวก campaign/segment, A/B test มีนัยสำคัญทางสถิติจริง, ROI ที่ซื่อสัตย์ต่อมาร์จิ้น และ export audience แบบ hash-only ตาม PDPA",
        "features":[
            ("Campaign & Segment","campaign active/inactive, RFM segment (VIP/Loyal/At-Risk/New), abandoned-cart nudge, survey/NPS"),
            ("โปรโมชัน & กฎราคา","Percent/Amount/BuyXGetY/Bundle/MinSpend/FreeGift, กฎ percent/fixed/bogo/qty-break + gate วัน/เวลา/ช่องทาง"),
            ("LINE marketing ปิดลูป","trigger lapsed/birthday/winback, คูปองต่อคนตามช่องทาง, redeem ปิดลูป, A/B + holdout ด้วย hash bucketing"),
            ("A/B มีนัยสำคัญจริง","Wilson 95% CI + z-test p-value, verdict real/underpowered/no-effect (p<.05 และกลุ่ม ≥30)"),
            ("ROI ซื่อสัตย์มาร์จิ้น","ส่วนลด = ต้นทุนไม่ใช่รายได้, join ต้นทุนอาหารจริง, วัด lift เทียบ holdout"),
            ("Export audience (PDPA-05)","fail-closed 2 ชั้น (ROPA + consent สด), ส่งเฉพาะ SHA-256 hash ไป Meta/Google, ถอน consent = ลบออกจริง"),
        ]})
    S.append({"t":"mod_ctrl","family":"Marketing · ราคา & โปรโมชัน","accent":"coral",
        "title":"ส่วนลดขึ้นใช้ไม่ได้จนกว่าจะมีคนอนุมัติ",
        "controls":[
            "MKT-01/R10 กฎราคา/โปรโมชัน maker-checker (status PendingApproval → คนละคน activate); engine อ่านเฉพาะ active",
            "MKT-02 promotion max_uses บังคับแบบ atomic",
            "REV-20 voucher campaign activation maker-checker + single redemption + void มี audit",
            "MKT-04/05/PDPA-05 บังคับ consent ทุกการส่ง; export double fail-closed, hash-only, removal-synced",
        ],
        "wow":[
            "ส่วนลดขึ้นใช้ไม่ได้จนคนละคนอนุมัติ — มาร์จิ้นถูกแจกเงียบไม่ได้",
            "A/B ที่ไม่โกหก — CI + p-value จริง พร้อม verdict 'underpowered — เพิ่มกลุ่ม'",
            "ส่ง audience ไป Meta/Google โดย PII ไม่หลุด — hash-only, gate ด้วย ROPA + consent, ถอนแล้วลบจริง",
            "ROI ที่นับส่วนลดเป็นต้นทุน วัด lift เทียบ holdout — ไม่หลอกตัวเอง",
        ],
        "routes":["/marketing","/settings/messaging","/crm/audience-export","/reputation","/mmm"]})

    # 5 — Returns / Gift cards (single)
    S.append({"t":"two_panel","family":"คืนสินค้า & บัตรของขวัญ","accent":"green",
        "kicker":"เจาะลึก · คืนเงิน / คืนสินค้า / stored value","title":"คืนเงิน–คืนสินค้า & บัตรของขวัญ ด้วย atomic integrity",
        "section":"เจาะลึกแต่ละโมดูล",
        "left":("คืนสินค้า & คืนเงิน","↺","green",[
            ("RTN- atomic","คืนเงิน+รับเข้าสต๊อก+บันทึก+reverse GL/COGS ทั้งหมดในทรานแซกชันเดียว — ล้มก็ rollback"),
            ("คืนตามสัดส่วน","lineNet ตาม qty ที่คืน + VAT ตามสัดส่วน; เงินสด/บัตร/QR หรือ Store Credit"),
            ("RET-01/REV-06 กันเกิน","OVER_RETURN (สะสม) + OVER_REFUND ใต้ payment-row lock"),
            ("RET-03/R12/R08 SoD","อนุมัติคืนเงินแยกจากทำรายการคืน — /pos/refunds ซ่อนจากแคชเชียร์ (บังคับที่ UI ด้วย)"),
        ]),
        "right":("บัตรของขวัญ & Store Credit","▤","teal",[
            ("GC- = หนี้สิน 2200","≤5,000 ฿ ออก Active อัตโนมัติ; >5,000 ฿ pending จนผู้เงินอิสระอนุมัติ (GC-01/R14)"),
            ("GC-03 กัน double-spend","redeem ใต้ card-row FOR UPDATE lock"),
            ("Sub-ledger GCT-","บันทึกทุก issue/redeem/top-up, tie-out กับ GL 2200 + breakage review"),
            ("Store Credit ชั้นหนึ่ง","คืนเป็นเครดิตร้าน = สร้างบัตร 2200 จริงพร้อม sub-ledger เต็ม"),
        ])})

    # 6 — Procurement / P2P
    S.append({"t":"mod_over","family":"จัดซื้อ · Procure-to-Pay","accent":"teal","glyph":"⛃","tag":None,
        "title":"วงจรจัดซื้อ–จ่ายที่แยกหน้าที่ทุกขั้น",
        "positioning":"วงจรรายจ่ายที่แยกหน้าที่เต็มรูป PR→PO→รับของ→3-way match→จ่าย โดยแต่ละขั้นอยู่คนละหน้าจอ — จับคู่ประสบการณ์ซื้อสไตล์ Shopee/LINE กับการควบคุม maker-checker ระดับ SOX: 'จ่ายเฉพาะของที่สั่งถูก รับจริง ราคาตกลง ผู้ขายอนุมัติ และผ่านการอนุญาต'",
        "features":[
            ("คำขอซื้อ & Shop","PR โดยใครก็ได้ (pr_raise), /shop แคตตาล็อกรูปภาพ + favourites/รายการประจำ sync ข้ามเครื่อง, สแกนบาร์โค้ด, project-scoped"),
            ("LINE OA chatbot","สร้าง/อนุมัติ PR, receive, claim, spend, บิล, AI ร่าง PR — ทุกเส้นทางเล่น createPr/workflow เดิม, SoD ผูกเหมือนกัน"),
            ("RFQ & PO","ใบขอเสนอราคา PDF, PO multi-currency, ธง capital line → fixed-asset register, แนบรูปบิล"),
            ("รับของแบบนับตาบอด (EXP-12)","/receiving ไม่ pre-fill จำนวนนับ, gate OVER_RECEIPT, สรุปสั่ง-vs-รับ, claim window 24 ชม.พร้อมรูปหน้าท่า"),
            ("3-way match & AP intake","PO↔GR↔Invoice ในเกณฑ์, doc-AI สแกนบิล auto-map PO ลงบิล+match ในสเต็ปเดียว, กันบิลซ้ำ"),
            ("Supplier scorecards & portal","จัดอันดับผู้ขาย on-time/quality/price, พอร์ทัลผู้ขาย acknowledge PO/ส่งบิล — จ่ายเงินตัวเองไม่ได้"),
        ]})
    S.append({"t":"mod_ctrl","family":"จัดซื้อ · Procure-to-Pay","accent":"teal",
        "title":"กันทุจริตจัดซื้อ–จ่าย ทุกจุดตัดสินใจ",
        "controls":[
            "R03/R04/R07 buyer ≠ receiver ≠ approver; รับของต้อง wh_receive (procurement เฉย ๆ รับไม่ได้)",
            "EXP-06 จ่ายเจ้าหนี้ maker-checker (creditors ≠ approvals/gl_close); EXP-09 MATCH_BLOCKED บิลผูก PO ที่ยังไม่ match",
            "EXP-11 เปลี่ยนบัญชีธนาคารผู้ขาย maker-checker (กัน BEC) + เข้ารหัส at rest",
            "EXP-12 gate OVER_RECEIPT (เกินได้เฉพาะ UoM น้ำหนัก 5%), claim window, close-short ระดับบรรทัด",
            "EXP-13 payment run maker-checker (เสนอ≠อนุมัติ≠สั่งจ่าย); ไฟล์ธนาคาร SHA-256-pinned",
        ],
        "wow":[
            "สั่งซื้อจาก LINE chat โดยการควบคุมไม่หาย — ทุกเส้นทางเล่น flow เว็บเดิม SoD/maker-checker ผูกเหมือนกัน",
            "doc-AI สแกนบิลแล้ว match เอง — แตก vendor/PO/ยอด, auto-map, ลงบิล, 3-way, ปฏิเสธซ้ำ, ปล่อยบิลมาก่อนของอัตโนมัติ",
            "รับของแบบนับตาบอด — ไม่ pre-fill จำนวน + กันรับเกิน, มี claim window 24 ชม.พร้อมรูปหลักฐานหน้าท่า",
            "ป้องกัน BEC ในตัว — บัญชีผู้รับเงินล็อกแก้ + dual control + เข้ารหัส, ไฟล์จ่าย SHA-256 ผูกกับ run ที่อนุมัติ",
        ],
        "routes":["/requisitions","/shop","/receiving","/procurement/match","/procurement/ap-intake","/disbursements"]})

    # 7 — Inventory & WMS
    S.append({"t":"mod_over","family":"คลังสินค้า · WMS & ต้นทุน","accent":"cyan","glyph":"▦","tag":None,
        "title":"สต๊อกแบบ perpetual มีมูลค่า ผูก GL ทุกงวด",
        "positioning":"บัญชีย่อยสินค้าคงคลังแบบ perpetual มีมูลค่า — สต๊อกครบถ้วน ขายเกินไม่ได้ คิดต้นทุนถูกตอนใช้ กระทบยอด GL 1200 ทุกงวด ครอบคลุม WMS (bin 3D, wave, สแกนมือถือ) + engine ต้นทุน (moving-avg/FIFO/FEFO, landed cost, standard cost) พร้อม maker-checker ทุกการทำลายมูลค่า",
        "features":[
            ("บัญชีสต๊อก perpetual (INV-06)","รับ/จ่าย/ปรับ ลง JE บาลานซ์ idempotent ต่อ ref, no-oversell (NEG_STOCK), banner กระทบยอด GL 1200"),
            ("วิธีต้นทุน","moving-average (default) หรือ FIFO/FEFO layers (แต่ละ layer พก lot+วันหมดอายุ) — เลือกต่อ item"),
            ("Landed cost (COST-01)","ค่าขนส่ง/อากร/ประกัน capitalize เข้าต้นทุนต่อหน่วยตาม value/qty/weight; std-cost roll maker-checker"),
            ("นับสต๊อก & cycle count (INV-17)","แยกจอ นับ (wh_count) ≠ ปรับ (wh_adjust), ABC classification + cadence + นับตาบอด"),
            ("Transfer orders (INV-16)","โอนระหว่างคลัง 2 สเต็ป ship→receive ผ่านบัญชี Goods-in-Transit 1255, ผู้ส่ง≠ผู้รับ, รายงาน aging"),
            ("WMS 3D & lot recall (INV-18)","ผังคลัง 3D ระบายสีตาม utilization, over-fill reject, lot genealogy 2 ทาง + quarantine hold ตัดออกจาก FEFO/wave"),
        ]})
    S.append({"t":"mod_ctrl","family":"คลังสินค้า · WMS & ต้นทุน","accent":"cyan",
        "title":"มูลค่าสินค้าที่พิสูจน์ตัวเองได้",
        "controls":[
            "R11 คนปรับ (wh_adjust) ≠ คนนับ (wh_count) — บังคับด้วย 2 หน้าจอแยกกันจริง",
            "INV-01 no oversell (FOR UPDATE + NEG_STOCK/PICK_SHORT); INV-04 counter ≠ variance-poster",
            "INV-07 write-off maker-checker (ผูกแม้ Admin); INV-16 shipper ≠ receiver; INV-08 bin capacity",
            "COST-01/02 preparer ≠ poster; QC-03 CoA recorder ≠ deviation approver",
        ],
        "wow":[
            "ผังคลัง 3D หมุนดูได้ — bin ระบายสีตามความจุ, พิมพ์ Item ID แล้ว bin ที่มีของสว่างม่วง + กัน over-fill",
            "บัญชีย่อยที่ผูก GL เสมอ — ทุกการเคลื่อนไหวลง JE บาลานซ์, idempotent, กระทบยอดบัญชี 1200",
            "นับ cycle-count ตาบอดตามความเสี่ยง — ABC จัดอันดับ, ของ A นับทุกเดือน, ซ่อนยอดสมุดจากผู้นับ",
            "เรียกคืนล็อตในคลิกเดียว — genealogy 2 ทาง + hold ที่ตัดล็อตออกจาก FEFO และ wave allocation จริง",
        ],
        "routes":["/inventory","/inventory-ledger","/wms","/lots","/stock-ops/cycle-counts","/costing/landed-cost"]})

    # 8 — Manufacturing
    S.append({"t":"mod_over","family":"การผลิต · Manufacturing","accent":"violet","glyph":"⚙","tag":None,
        "title":"BOM→สินค้าสำเร็จรูป พร้อม APS finite-capacity",
        "positioning":"engine ต้นทุน BOM→สินค้าสำเร็จรูปที่ WIP/FG/absorption/COGS ถูกต้องครบถ้วน ตัดงวด และอนุมัติ — ทุก posting ลง GL แบบบาลานซ์ idempotent บวกการวางแผนสมัยใหม่ (MRP หลายระดับ, RCCP, APS finite-capacity) บน maker-checker BOM governance",
        "features":[
            ("BOM & work order","BOM master + distribution (maker-checker), roll-up ต้นทุน+labor+overhead, WO Open→Released→Completed"),
            ("Material issue & variance (MFG-02)","Dr WIP/Cr Raw idempotent, FG ที่ std×ผลิตจริง, yield variance → 5810 (WIP relieved เสมอ)"),
            ("MRP หลายระดับ","BOM explosion recursive, netting on-hand, Make+Buy, plan-to-PR (แยกจากการซื้อ), lot-sizing/EOQ, RCCP"),
            ("APS finite-capacity","จัด operation ลง work center — predecessor gating + one-op-at-a-time + EDD → schedule, dispatch queue, makespan, ธง late"),
            ("Costing config","FIFO/AVG/STD ต่อ tenant+item, GR capitalization, STD → PPV ไป 5500 เป็น plug เดียว"),
            ("Streaming analytics","BiLive SSE push kpi_refresh สู่ dashboard สด"),
        ]})
    S.append({"t":"mod_ctrl","family":"การผลิต · Manufacturing","accent":"violet",
        "title":"ต้นทุนผลิตที่ซื่อสัตย์ต่อ variance",
        "controls":[
            "R04 ผู้สร้าง WO ≠ ผู้รับ; R13 BOM/costing config แยกจากการทำรายการ",
            "MFG-01 HQ BOM governance + maker-checker; MFG-02 JE บาลานซ์ idempotent + yield/material variance",
            "MFG-03 STD PPV → 5500; GL-01 balanced JE",
            "COST-02/MDM-01 std-cost roll: preparer (md_config) ≠ approver (exec)",
        ],
        "wow":[
            "APS finite-capacity บน RCCP — schedule ต่อ operation จริง (start/finish, dispatch queue, makespan, ธง late) เคารพ predecessor",
            "ปิดงานแบบซื่อสัตย์ variance — yield ขาดเข้า 5810 (ไม่ capitalize เข้า FG), material variance โผล่ ไม่ซ่อนใน FG cost",
            "MRP หลายระดับที่กลายเป็น PR จริง — explosion + EOQ/lot-sizing แล้ว plan-to-PR เข้าflow จัดซื้อที่แยกหน้าที่",
            "ทุก posting การผลิต idempotent + บาลานซ์ — re-issue/re-complete เป็น no-op, PPV เป็น plug เดียว JE ไม่ reject",
        ],
        "routes":["/manufacturing","/production","/production/schedule","/costing","/bom"]})

    # 9 — Quality
    S.append({"t":"mod_over","family":"คุณภาพ · QMS","accent":"coral","glyph":"◇","tag":None,
        "title":"NCR · CAPA · SCAR/8D · CoA — ไม่มีใครเซ็นทิ้งเองได้",
        "positioning":"ระบบคุณภาพครบวงจรที่ปิดช่องว่างใหญ่สุดของวงจรคุณภาพ: ไม่มีผู้ตรวจคนใดทิ้งสต๊อก ปล่อยของนอกสเปค requalify ผู้ขาย หรือปิด corrective action ด้วยลายเซ็นตัวเอง — NCR/CAPA/SCAR/CoA แต่ละอันบังคับผู้อนุมัติคนที่สองอิสระ ทุก scan disposition ลง write-off ที่คุมได้",
        "features":[
            ("NCR register (QC-01)","open→pending_disposition→dispositioned→closed, scrap ลง Dr 5810/Cr inventory ต้นทาง, defect-code taxonomy"),
            ("CAPA (QC-02)","corrective/preventive loop, action items, submit→pending_verification, effectiveness sign-off (ไม่ได้ผลเปิดใหม่)"),
            ("SCAR/8D (QC-04)","supplier corrective action ฟิลด์ 8D (D3–D7), effectiveness verdict gate การ requalify ผู้ขาย"),
            ("Certificate of Analysis (QC-03)","spec ต่อ item (min–max), evaluate pass/fail, out-of-spec deviation release + register"),
            ("Disposition/scrap","Accept/Rework/Quarantine/Scrap, เขียนมูลค่าเสียเข้า loss"),
            ("Waste capture","reason × disposition บน /waste, void-fire recipe explosion, variance ทฤษฎี-vs-จริง"),
        ]})
    S.append({"t":"mod_ctrl","family":"คุณภาพ · QMS","accent":"coral",
        "title":"ทุก disposition ต้องลายเซ็นที่สอง",
        "controls":[
            "R21 ผู้ราย/เจ้าของ (quality) ≠ ผู้อนุมัติ/verify (quality_approve/exec)",
            "QC-01 NCR disposition maker-checker (dispositioned_by ≠ raised_by, ผูก Admin)",
            "QC-02 CAPA effectiveness verify (verified_by ≠ owner; action ครบ; ไม่ได้ผล = reopen)",
            "QC-03 out-of-spec release (recorder ≠ approver + reason); QC-04 SCAR closure (closer ≠ raiser, 8D ครบ)",
        ],
        "wow":[
            "scrap เซ็นเองไม่ได้ — ทุก disposition ทางการเงิน park จนคนละคนอนุมัติ + แสดงเลข JE write-off บน NCR",
            "CAPA ที่ตรวจ effectiveness — ปิดต้องมี verifier อิสระ + action ครบ, 'ไม่ได้ผล' เปิดเคสใหม่",
            "SCAR 8D ผูกกับการ requalify ผู้ขาย — ปิดได้เฉพาะ 8D ครบที่คนที่สองรีวิว, effective เท่านั้นถึง requalify",
            "CoA deviation register = sample พร้อมตรวจ — ทุกล็อตนอกสเปคมี recorder+approver+reason",
        ],
        "routes":["/quality/ncr","/quality/capa","/quality/scar","/quality/coa"]})

    # 10 — Master Data (single)
    S.append({"t":"cards","kicker":"เจาะลึก · Master Data Management","title":"ข้อมูลหลัก: engine เดียว คุมทุก entity + กันทุจริต","accent":"teal","cols":3,
        "section":"เจาะลึกแต่ละโมดูล",
        "intro":"registry เดียวคุมทุก master (item/ลูกค้า/ผู้ขาย/ราคา/โปรโมชัน/BOM) — import/export, validate ต่อแถว, maker-checker ฟิลด์การเงิน, audit trail แก้ไม่ได้",
        "cards":[
            ("⇅","Registry engine เดียว","export→แก้ Excel→dry-run validate→commit เหมือนกันทุก entity, error TH/EN ต่อแถว (ไม่ fail-on-first)","teal"),
            ("⛨","ฟิลด์อ่อนไหว 2 คน","credit limit/payment terms/ราคา/ส่วนลด — batch/single staged, ปล่อยโดยผู้อนุมัติอิสระ (SOD_VIOLATION)","coral"),
            ("◆","DQM ระดับ Oracle","ตรวจซ้ำ (tax-id/barcode + fuzzy name) + match-merge repoint ลูก, survivorship, soft-retire ไม่ลบ","violet"),
            ("▤","ประวัติแก้ไขแก้ไม่ได้","data_change_log ที่ DB layer append-only, mask ฟิลด์อ่อนไหว — หลักฐานที่แก้/ลบไม่ได้","cyan"),
            ("⬒","Custom fields (UDF)","ฟิลด์ typed no-code (text/number/date/select) บนทุก entity, validate ฝั่ง server","gold"),
            ("◷","Setup IO surface","item_categories + tax_codes ผ่าน engine เดียวกัน gate สิทธิ์แคบ (md_item/md_config)","green"),
        ]})

    # 11 — Finance AR/AP
    S.append({"t":"mod_over","family":"การเงิน · ลูกหนี้ & เจ้าหนี้","accent":"teal","glyph":"₿","tag":None,
        "title":"ศูนย์เงินหมุนเวียน AR/AP สไตล์ PEAK",
        "positioning":"ศูนย์กลาง working capital ที่รวมวงจรลูกหนี้–เจ้าหนี้ในหน้าเดียว — การ์ด statement, ตัดชำระข้ามใบแจ้งหนี้, วงจรอนุมัติจ่าย maker-checker, ควบคุมเครดิต, เงินทดรอง และทวงหนี้อัตโนมัติ ทุกจุดสัมผัสเงินสดแยกหน้าที่และลง GL อัตโนมัติ",
        "features":[
            ("การ์ดลูกหนี้/เจ้าหนี้","statement opening→running→closing balance, multi-currency (booked FX), export CSV/PDF/อีเมล"),
            ("Customer 360","เครดิตเทอม, ที่อยู่หลายรายการ, related party (SOX), find & merge, ประวัติแก้ไข hash-chained"),
            ("AR & cash application (REV-21)","INV- + รับชำระ RCP-, ตัดชำระหลายใบ, เศษพัก on-account 2220, ตัด ≥100,000 ฿ ต้องอนุมัติที่สอง"),
            ("AP & payment run (EXP-13)","บันทึกบิล AP-, จ่ายหลายเจ้าหนี้ครั้งเดียว, ไฟล์ SCB/KBank/BBL/ISO20022 pain.001 + SHA-256"),
            ("Allowance หนี้สงสัยจะสูญ","aging buckets loss-rate → Dr 5720/Cr 1190 (posts เฉพาะ delta)"),
            ("เงินทดรอง & petty cash","advance ADV- (1180), imprest fund (1015), early-payment discount → 4600"),
        ]})
    S.append({"t":"mod_ctrl","family":"การเงิน · ลูกหนี้ & เจ้าหนี้","accent":"teal",
        "title":"แยกทีมจริง 2 หน้าจอ: ขอจ่าย ≠ ปล่อยเงิน",
        "controls":[
            "EXP-06 จ่ายเจ้าหนี้ maker-checker: ผู้ขอ (creditors) ≠ ผู้อนุมัติ (approvals/gl_close), ผูกแม้ Admin",
            "EXP-09 3-way match gate: บิลผูก PO ต้องผ่านก่อนจ่าย (MATCH_BLOCKED)",
            "REV-08 credit-manager maker-checker: เปลี่ยน limit/ปลด hold ต้องคนที่สอง",
            "REV-12 credit hold/serious-overdue: เกินวงเงินหรือค้าง 90+ วัน → hold บังคับถึง POS/portal",
            "REC-02/R06 bank reconciliation: ผู้เตรียม ≠ ผู้รับรอง",
        ],
        "wow":[
            "แยกทีมจริง 2 หน้าจอ — Accounting ขอจ่าย (/finance), Finance ปล่อยเงิน (/disbursements) กันคนเดียวทั้งบันทึกและจ่าย",
            "ไฟล์โอนธนาคารไทยพร้อมใช้ — SCB/KBank/BBL + ISO 20022 + SHA-256 พิสูจน์ไฟล์ = ที่อนุมัติ",
            "credit hold บังคับถึงหน้าร้าน POS และ portal ด้วย threshold 90 วันเดียวกับ collections",
            "statement multi-currency เก็บ booked FX rate ต่อเอกสาร",
        ],
        "routes":["/finance","/finance/customers","/disbursements","/finance/credit-hold","/advances"]})

    # 12 — GL & Close
    S.append({"t":"mod_over","family":"บัญชีแยกประเภท · GL & ปิดงวด","accent":"gold","glyph":"≣","tag":None,
        "title":"GL balanced-by-construction + Close Cockpit",
        "positioning":"แกน double-entry ledger ที่บาลานซ์โดยโครงสร้าง มี maker-checker บังคับแม้ Admin ปิดงวดด้วย Close Cockpit RAG board, flux analysis + disclosure checklist — ออกแบบให้ผ่านการตรวจ ICFR/SOX โดยตรง",
        "features":[
            ("Manual JE (GL-05)","posts เป็น Draft (ตัดออกจาก TB) จนคนละคนอนุมัติ, Σdebit=Σcredit, idempotent (tenant,source,ref,ledger)"),
            ("งบการเงิน + Cash Flow","TB/IS/BS + SCF ทั้ง indirect & direct (reconcile Δcash by construction), forecast 13 สัปดาห์จาก AR/AP"),
            ("Recurring & Prepaid (GL-08/09)","template balanced, job posts Draft ผ่าน maker-checker; prepaid straight-line Dr expense/Cr 1280"),
            ("Allocation cycles (GL-23)","ratio/driver/statistical → JE บาลานซ์เดียว, เศษไป target สุดท้าย"),
            ("Chart of Accounts (GL-11/27)","canonical universe (shared) + tenant overlay (RLS), control-account guard, industry template"),
            ("Posting rules/overrides (GL-24)","registry 74 events/125 roles, override → PendingApproval, pinned accounts แก้ไม่ได้, audit append-only"),
        ]})
    S.append({"t":"mod_ctrl","family":"บัญชีแยกประเภท · GL & ปิดงวด","accent":"gold",
        "title":"หลักฐาน ICFR สำเร็จรูป",
        "controls":[
            "GL-01 balanced · GL-02 period lockout · GL-04 idempotency · GL-05 manual-JE maker-checker (opening balances ก็ผ่าน — ปิด gap G4)",
            "REC-04 period-end control-account pack: AR↔1100, AP↔2000, Inventory↔1200, Gift cards↔2200 ในอ่านเดียว",
            "GOV-01 pending-approvals monitor: worklist รวมทุกรายการรออนุมัติ + age + overdue",
            "GL-22 Close Cockpit RAG · GL-25 Flux (บังคับคำอธิบาย + sign-off) · GL-26 Disclosure checklist (TFRS/IFRS/SEC)",
        ],
        "wow":[
            "opening balances ผ่าน maker-checker เดียวกัน — go-live posting ที่ material ที่สุดไม่ถูก seed คนเดียว",
            "Close Cockpit = จอเดียว 'พร้อมปิดหรือยัง' RED/GREEN — ไม่ต้องเปิดหลายจอ",
            "flux analysis บังคับคำอธิบาย + sign-off และ disclosure close binder — หลักฐาน ICFR พร้อมตรวจ",
            "cash flow ทั้ง 3 งบ reconcile กับเงินสดจริง (ตัด year-end close journals ออก)",
        ],
        "routes":["/accounting","/chart-of-accounts","/finance/close-cockpit","/close/flux","/close/disclosure"]})

    # 13 — Multi-GAAP / Consolidation / FX
    S.append({"t":"mod_over","family":"Multi-GAAP · งบรวม & FX","accent":"violet","glyph":"⧉","tag":None,
        "title":"Parallel ledger + งบรวม dual-rate + FX revaluation",
        "positioning":"สถาปัตยกรรม parallel-ledger (TFRS/TAX/IFRS) โพสต์ครั้งเดียวเข้าทุก ledger แต่ isolate adjustment; งบรวม HQ-only มี dual-rate FX translation + CTA/OCI + consolidated SCF; FX revaluation อัตโนมัติพร้อม auto-reversal — รองรับ multi-GAAP และ group reporting ระดับ IFRS",
        "features":[
            ("Parallel ledgers (GAAP-01..04)","TFRS (statutory) / TAX (สรรพากร) / IFRS (group); shared entry → ทุก ledger, adjustment → ledger เดียว"),
            ("gaap-comparison","base TFRS vs TAX — shared entries cancel เหลือ diff จริง ป้อน deferred tax + ภ.ง.ด.50"),
            ("Intercompany (IC-01..04)","HQ-only, 2 legs Due-From 1150/Due-To 2150, settlement over-pay guard, reconciliation eliminate flag"),
            ("Consolidation (CON-03..05)","entity ownership-weighted + NCI 3300 + elimination, balanced-TB assertion (rollback ถ้าไม่บาลานซ์)"),
            ("Dual-rate translation (CON-05)","P&L @ average, BS @ closing → CTA เข้า OCI 3400 (IAS 21) + consolidated SCF (IAS 7)"),
            ("FX revaluation (FX-01..04)","unrealized บน open non-THB AR/AP, JE + 5400 FX G/L, auto-reverse วันที่ 1 เดือนถัดไป"),
        ]})
    S.append({"t":"mod_ctrl","family":"Multi-GAAP · งบรวม & FX","accent":"violet",
        "title":"งบรวมข้ามสกุลระดับ IFRS ที่บาลานซ์เสมอ",
        "controls":[
            "GAAP-02/GL-05 adjustment maker-checker; GAAP-04 per-ledger close (lock เฉพาะ LEADING)",
            "IC-01/R01 HQ-only gate; CONS-02/R07 run ต้อง approvals ≠ initiator",
            "CON-03 elimination integrity + post maker-checker (CONSOL_UNBALANCED → rollback); REC-03 IC-recon sign-off gate",
            "FX-04 rate maker-checker: manual rate = PendingApproval ใช้ไม่ได้จนอนุมัติ (กัน fat-finger 36→63)",
        ],
        "wow":[
            "โพสต์ครั้งเดียว GAAP หลายเล่ม — TFRS/TAX/IFRS แยกเฉพาะ adjustment, book-tax difference วัดสะอาด",
            "dual-rate translation + CTA/OCI + consolidated SCF ตาม IAS 21/IAS 7 — งบรวมข้ามสกุลระดับ IFRS",
            "งบรวม rollback ถ้า TB ไม่บาลานซ์ — eliminations เงียบ ๆ ทำ group ไม่บาลานซ์ไม่ได้",
            "FX rate ผิดโพสต์ไม่ได้ — Approved-only ป้องกัน revalue ที่ทำ earnings/equity ผิด",
        ],
        "routes":["/consolidation","/intercompany","/fx","/ic-reconciliation"]})

    # 14 — Revenue Recognition
    S.append({"t":"mod_over","family":"รับรู้รายได้ · TFRS/IFRS 15","accent":"green","glyph":"◕","tag":None,
        "title":"รับรู้รายได้ 5 ขั้นตอนเต็มรูปแบบ",
        "positioning":"engine รับรู้รายได้ TFRS 15/IFRS 15 five-step เต็มรูปแบบ ครอบคลุม contract asset/liability, progress/milestone billing, variable consideration + constraint, contract modifications, financing component และ disclosure pack — ทุกดุลพินิจฝ่ายบริหารเป็น maker-checker artifact",
        "features":[
            ("Five-step engine (REV-19)","contract → performance obligations (SSP) → allocate → recognize, postings ผ่าน LedgerService"),
            ("Contract asset vs liability (REV-24)","แยก billing จาก recognition, ล้ำ = asset 1265, milestone maker-checker (SOD_SELF_BILLING)"),
            ("Variable consideration (REV-25)","expected-value/most-likely + constraint, maker-checker → re-estimate → cumulative catch-up"),
            ("Contract modifications (REV-26)","classify separate/prospective/cumulative-catchup — classification คือ control, maker-checker"),
            ("Financing component (REV-27)","discount to PV, EIR interest unwind, maker-checker discount-rate"),
            ("Disclosure pack","contract-liability rollforward + RPO/backlog (BI report), reconcile GL 2410/1265"),
        ]})
    S.append({"t":"mod_ctrl","family":"รับรู้รายได้ · TFRS/IFRS 15","accent":"green",
        "title":"ดุลพินิจฝ่ายบริหารทุกจุด = maker-checker",
        "controls":[
            "REVREC-01..04 defer/split/period-scope/classify",
            "REV-24/25/26/27 ทุกตัว maker-checker (SOD_SELF_BILLING/SOD_SELF_APPROVAL) — estimate ที่ pending ขับรายได้ไม่ได้",
            "REC-01 deferred-revenue tie-out; GL-01 balanced",
        ],
        "wow":[
            "TFRS 15 ครบทั้ง 5 waves — asset/liability split, variable + constraint, 3-way modification, financing (EIR), §120 disclosure",
            "contract-asset reclass ties by construction (Σ 1265 = Σ recognized − Σ billed)",
            "ดุลพินิจฝ่ายบริหารทุกจุดเป็น maker-checker — auditor-friendly",
            "disclosure rollforward สร้างใหม่จาก GL journal lines — reconcile by construction",
        ],
        "routes":["/revenue","/api/revenue/contracts","/api/revenue/disclosure"]})

    # 15 — Fixed Assets / Leases
    S.append({"t":"mod_over","family":"สินทรัพย์ถาวร · Leases & EAM","accent":"cyan","glyph":"▣","tag":None,
        "title":"สินทรัพย์ครบวงจร + IFRS 16 + deferred tax",
        "positioning":"วงจรสินทรัพย์เต็มรูป — capitalize จาก GR, depreciation, revaluation/impairment, disposal — พร้อม IFRS 16 lease accounting (lessee + lessor), EAM work orders, parallel tax-depreciation book ป้อน deferred tax และ QR audit-by-scan ทุก posting เป็น maker-checker",
        "features":[
            ("ทะเบียน & capitalize (FA-10)","category defaults, capital line จาก GR ตัดออกจาก inventory → request → อนุมัติ → asset + traceability"),
            ("Depreciation (FA-02)","monthly run idempotent ต่อ (tenant:period), หนึ่ง DEP- ต่อ tenant, cap ที่ NBV−salvage"),
            ("Revaluation/impairment (FA-07)","up Dr 1500/Cr 3200 surplus, disposal recycle surplus Dr 3200/Cr 3100 ตรงเข้า RE"),
            ("Leases lessee & lessor (LSE-01/02)","IFRS 16: ROU 1600/liability 2600 @ PV, interest+payment+dep, liability tie-out banner"),
            ("EAM work orders (FA-06)","MWO- corrective/preventive, cost → AP Dr 5710, PM schedules, reliability KPI (MTBF)"),
            ("Deferred tax (TAX-06)","parallel tax book (Thai caps, memo-only) → DTA/DTL Dr 1700/Cr 5950 delta, maker-checker"),
        ]})
    S.append({"t":"mod_ctrl","family":"สินทรัพย์ถาวร · Leases & EAM","accent":"cyan",
        "title":"IFRS 16 ทั้ง lessee & lessor + tax book จริง",
        "controls":[
            "FA-01..13 life guard, balanced, idempotency, salvage cap, maker-checker บน capitalize/disposal/revaluation/custody",
            "R07 initiate ≠ approve; R05 gl_post ≠ gl_close; EXP-05 WO→AP",
            "TAX-06/FIN-6a deferred tax maker-checker; LSE-01/LSE-02 lease tie-outs",
        ],
        "wow":[
            "IFRS 16 ทั้งฝั่ง lessee และ lessor พร้อม lease-liability tie-out banner ที่หน้าจอ",
            "parallel tax-depreciation book ป้อน deferred tax จาก difference จริง — ไม่ต้อง manual adjustment",
            "capitalize จาก GR ด้วย traceability PR→PO→GR→FA + capital line ตัดออกจาก inventory อัตโนมัติ",
            "QR audit-by-scan + BI existence-exception (FA-12) — detective control สำหรับ physical existence",
        ],
        "routes":["/assets","/leases","/eam","/deferred-tax"]})

    # 16 — Tax
    S.append({"t":"mod_over","family":"ภาษี · VAT/WHT/e-Tax","accent":"coral","glyph":"₧","tag":"THAI-LEGAL",
        "title":"ชุดภาษีไทยครบ + e-Tax UBL 2.1 + XAdES",
        "positioning":"ชุดภาษีไทยครบวงจร — VAT 7% output/input, WHT + ภ.ง.ด., ใบกำกับภาษีตาม ม.86/4, e-Tax UBL 2.1 + XAdES digital signature, ภ.พ.30/36, ภ.ธ.40 และ income-tax provision + ETR (ASC 740/IAS 12) — ทุกภาษี reconcile กับ GL ก่อนยื่น",
        "features":[
            ("Rate config (TAX-01)","TaxProvider ต่อประเทศ (TH 7%, SG GST 9%, MY SST 6%) — ไม่มี hard-coded rate"),
            ("ใบกำกับภาษี ม.86/4","เลข gapless monthly atomic, void เก็บเลขไม่ reuse + exception report, ABB→full conversion (TAX-10)"),
            ("e-Tax (TAX-02)","ETDA UBL 2.1 XML + XAdES enveloped signature (RSA-SHA256), PDF/A-3 ฝัง XML, idempotent, durability retry"),
            ("CN/DN + reverse-charge","ม.86/10, ภ.พ.36 reverse-charge (ม.83/6) Dr 1300/Cr 2120, ภ.ธ.40 SBT 3.3%"),
            ("WHT (TAX-03)","คำนวณ + 50-ทวิ อัตโนมัติ, ภ.ง.ด.3/53 transfer file (TIS-620, พ.ศ., เงื่อนไข)"),
            ("Provision + ETR (TAX-11)","pretax→M-1→temporary→CIT 20%, ETR reconciliation by construction, maker-checker"),
        ]})
    S.append({"t":"mod_ctrl","family":"ภาษี · VAT/WHT/e-Tax","accent":"coral",
        "title":"ยื่นสรรพากรได้จริง โดยไม่แก้ encoding",
        "controls":[
            "TAX-01..11 · REV-10 auto VAT · TAX-07 CN/DN maker-checker · TAX-06/11 provision maker-checker",
            "ทุก return reconcile GL ก่อนยื่น (tie verdict): ภ.พ.30 net = output − input vs GL 2100",
            "ใบกำกับ void เก็บเลข + exception report (G16); ABB→full idempotent (นับครั้งเดียวใน ภ.พ.30)",
        ],
        "wow":[
            "e-Tax UBL 2.1 + XAdES signature + PDF/A-3 — tamper-evident, ยื่น ETDA ได้จริง, submission ไม่หายแม้ SP ล่ม",
            "ครอบคลุมภาษีไทยครบ: VAT (ภ.พ.30), reverse-charge (ภ.พ.36), SBT (ภ.ธ.40), WHT (ภ.ง.ด.) — reconcile GL ทุกตัว",
            "RD transfer file: TIS-620 + วันที่ พ.ศ. + เงื่อนไข — ยื่น e-filing โดยไม่แก้ encoding",
            "Income-tax provision + ETR reconciliation (ASC 740/IAS 12) reuse deferred-tax run",
        ],
        "routes":["/tax/invoices","/tax/wht","/tax/reports","/tax/provision","/einvoice"]})

    # 17 — Treasury
    S.append({"t":"mod_over","family":"เทรเชอรี · เงินสด & ตราสาร","accent":"teal","glyph":"⛁","tag":None,
        "title":"เทรเชอรี + financial instruments IFRS 9",
        "positioning":"ศูนย์ควบคุมสภาพคล่องและตราสารการเงิน — POS till, safe-drop→bank deposit, bank reconciliation, Cash Command 13-week forecast และ financial-instruments register ตาม IFRS 9/TFRS 9 (debt, investments, hedging, cash pooling) ครบ EIR amortized-cost + OCI + hedge effectiveness",
        "features":[
            ("Till & cash banking (REC-05)","open float→close variance Z-report, safe drop→bank deposit Dr 1010, undeposited-drops = exposure"),
            ("Bank reconciliation (REC-02)","import CSV/XLSX (Thai/Eng, พ.ศ.), shared match-engine, fee/interest = Draft จนอนุมัติ, certifier ≠ preparer"),
            ("Cash Command (TR-01)","GL cash position + 13-week forecast + liquidity trough + KPI ratio + FX exposure ในจอเดียว"),
            ("Debt & borrowings (TRE-01/02)","facility maker-checker → drawdown → EIR interest accrual → repay, covenant tracking + breach"),
            ("Investments (TRE-03)","classify AMORTIZED_COST/FVOCI/FVTPL, MTM Approved-only, FVOCI→OCI 3500, ECL impairment"),
            ("Hedge accounting (TRE-04)","designation + effectiveness testing, ไม่มี OCI accounting จน Approved AND effective, cash-flow hedge OCI 3550"),
        ]})
    S.append({"t":"mod_ctrl","family":"เทรเชอรี · เงินสด & ตราสาร","accent":"teal",
        "title":"ตราสารการเงินครบ IFRS 9",
        "controls":[
            "REV-13/REC-05/REC-02/BANK-02/POS-08 cash & bank controls",
            "TR-01 cash command; TRE-01..05 ทุกตัว maker-checker (creator ≠ approver, R23 treasury ≠ treasury_approve)",
            "GL-05/GL-24 postings ผ่าน ledger period-lock; G9 bank-account creation maker-checker",
        ],
        "wow":[
            "financial-instruments register ครบ IFRS 9 — debt (EIR), investments (3-classification + OCI/P&L), hedge (effectiveness gate), pooling",
            "match-engine เดียวใช้ทั้ง GL bank rec และ PromptPay store rec — score เหมือนกัน",
            "13-week direct cash forecast + liquidity trough + FX exposure ในจอเดียว (TR-01)",
            "IC-loan + interest eliminate on consolidation — group นับ finance cost/income เป็นศูนย์",
        ],
        "routes":["/finance/treasury","/bank","/reconciliation","/cash-banking","/financial-health"]})

    # 18 — HR / HCM
    S.append({"t":"mod_over","family":"บุคลากร · HCM","accent":"violet","glyph":"⚇","tag":None,
        "title":"HCM ครบ — จาก recruiting ถึง ESS บนตัวตนเดียว",
        "positioning":"HCM ครบชุดบนตัวตนพนักงานเดียว (emp_code) — org structure, positions & headcount governance, recruiting/ATS, onboarding/offboarding, comp bands & benefits, training & certifications, performance และ ESS ทุก approval เป็น maker-checker (approver ≠ subject) ทุกตาราง RLS + PDPA",
        "features":[
            ("Org & positions (HR-01)","department hierarchy + cost center, budgeted positions + headcount, org chart budgeted-vs-filled"),
            ("Recruiting/ATS (HR-04)","job requisitions, candidate pool, pipeline applied→hired, offer → แปลงเป็น employee จริง"),
            ("Onboarding/offboarding (HR-05)","checklist templates, access-revocation completeness gate (joiner-mover-leaver)"),
            ("Comp bands & benefits (HR-06)","pay-grade band [min,mid,max], comp change within-band maker-checker, benefit enrollments"),
            ("Training & certs (HR-07)","course catalogue (mandatory/validity), certification auto-mint + expiry, detective compliance report"),
            ("ESS (HR-08)","แก้ข้อมูลตัวเอง — ฟิลด์อ่อนไหว (bank/national_id) park รอ HR, contact แก้ทันที, team directory"),
        ]})
    S.append({"t":"mod_ctrl","family":"บุคลากร · HCM","accent":"violet",
        "title":"headcount เกินจากภายในไม่ได้",
        "controls":[
            "HR-01 headcount governance: hire เกิน budgeted → HEADCOUNT_EXCEEDED (403), exec override audit-logged",
            "HR-03 performance sign-off SoD (SOD_SELF_REVIEW); HR-04 recruiting SoD; HR-06 comp within-band + maker-checker",
            "HR-05 offboarding access-revocation gate (ACCESS_REVOCATION_INCOMPLETE); HR-08 ESS profile maker-checker",
            "ITGC-AC-19 PII (national_id/bank) AES-256-GCM at rest; tiers hr/hr_admin/ess",
        ],
        "wow":[
            "headcount เกินจากภายในไม่ได้ — ทุก hire เกินอัตราเป็นการตัดสินใจ exec ที่ audit-logged, ปิดช่อง budget-creep",
            "offboarding gate = SOX joiner-mover-leaver จริง — access ต้องถูกลบพิสูจน์ได้ (หรือ exec waive) ก่อนปิด",
            "certifications auto-mint + expiry + supersede — credential หมดอายุพลาดไม่ได้ (detective report)",
            "พนักงานเปลี่ยนบัญชีรับเงินตัวเองเงียบไม่ได้ — park รอ HR อนุมัติ, contact edit ทันที",
        ],
        "routes":["/hcm/org","/hcm/recruiting","/hcm/onboarding","/hcm/comp","/hcm/training","/hcm/ess"]})

    # 19 — Payroll (single)
    S.append({"t":"two_panel","family":"เงินเดือน & เวลาทำงาน","accent":"gold",
        "kicker":"เจาะลึก · Payroll & Time-Labor","title":"เงินเดือนไทยครบกฎหมาย + maker-checker",
        "section":"เจาะลึกแต่ละโมดูล",
        "left":("Payroll engine ไทย","₿","gold",[
            ("PAY-01 gross-to-net","ประกันสังคม 5% cap 750, PIT ก้าวหน้า, PF — unit-tested ไม่มี ad-hoc rate"),
            ("PAY-02 statutory","ภ.ง.ด.1/1ก, payroll-liability schedule (SSO 2350/WHT 2360/PF 2370) reconcile"),
            ("PAY-06 payslip","PDF พิมพ์/อีเมล, mask เลขบัตร 4 ตัวท้าย, PDPA-scoped (ดูของตัวเองเท่านั้น)"),
            ("Async runs","10k คน off-thread (background_jobs), idempotent ต่อ (tenant,period)"),
        ]),
        "right":("PAY-03 maker-checker & Time","⛨","coral",[
            ("จ่ายเงินตัวเองไม่ได้","run posts เป็น Draft JE (ตัดออกจากยอด), self-approve = SOD_VIOLATION ผูกแม้ Admin"),
            ("PAY-04/05 OT rules","tiered OT บน พ.ร.บ.คุ้มครองแรงงาน (1.5×/2×/3×), labor % of sales alert"),
            ("Anti buddy-punch","clock-in PIN/QR/FACE, block ซ้ำ 15 นาที, GPS geofence"),
            ("ผูก GL + filing","liability schedule reconcile GL accrual vs payrun aggregate อิสระ"),
        ])})

    # 20 — Projects / PPM
    S.append({"t":"mod_over","family":"โครงการ · PPM & PMO","accent":"teal","glyph":"◲","tag":None,
        "title":"PPM/PMO ระดับโลก + วัสดุก่อสร้างครบลูป",
        "positioning":"แพลตฟอร์ม PPM/PMO ระดับ world-class บนแกน projects + CRM-pipeline — opportunity ชนะ → แปลงเป็นโครงการ, WBS/Gantt, rate card, EVM, baseline, risk register, PMO action center สด และลูปควบคุมวัสดุก่อสร้าง (BoQ→commitment budget→requisition→issue-to-WIP) พร้อม 23 project controls",
        "features":[
            ("Portfolio command center","CPI/SPI health, on-track vs at-risk, contract/billed/WIP/margin, capacity heatmap, forward cash"),
            ("PMO Action Center (PROJ-11)","worklist 'อะไรต้องการฉันตอนนี้' จัดอันดับ severity, push ผ่าน SSE (BiLive) ทันทีที่ drift"),
            ("Resources & capacity","rate card effective-dated (PROJ-05), capacity calendar, supply-vs-demand heatmap (PROJ-20), leveling"),
            ("EVM & schedule (PROJ-06)","BAC/PV/EV/AC→CPI/SPI/EAC, earned schedule SPI(t), CPM critical-path, FS/SS/FF/SF + lag/lead"),
            ("Baselines/RACI/risk (PROJ-07/08)","baseline change-control, WBS templates, RACI gap detection, risk register (P×I 1-25)"),
            ("วัสดุ & shop-for-project","BoQ maker-checker, commitment budget FOR UPDATE (BUDGET_EXCEEDED), PMR, issue-to-WIP (1260)"),
        ]})
    S.append({"t":"mod_ctrl","family":"โครงการ · PPM & PMO","accent":"teal",
        "title":"งบคุมได้จริง แบบ concurrency-safe",
        "controls":[
            "PROJ-04 timesheet→labor SoD (ผูกแม้ Admin); PROJ-05 resource/rate governance; PROJ-06 EVM detective",
            "PROJ-07 baseline change control; PROJ-08 unmitigated high-risk detective; PROJ-11 action-center",
            "PROJ-12 commitment budget enforcement (FOR UPDATE); PROJ-13 PMR over-budget approval; PROJ-15 BoQ scope-change",
            "PROJ-09 POC rev-rec; PROJ-10 change-order maker-checker; INV-13 issue-to-project; CRM-WL opp→project",
        ],
        "wow":[
            "PMO Action Center สด push exceptions ผ่าน SSE — โครงการแดง/risk ไม่มี mitigation ปลุก inbox ทันที",
            "งบ concurrency-safe — BoQ commitment lock บรรทัด, 2 PO พร้อมกัน overrun ไม่ได้, PO ทั้งใบ rollback",
            "Earned Schedule SPI(t) ที่ยังซื่อสัตย์ปลายโครงการ (ที่ SPI ปกติ drift กลับ 1)",
            "'Shop for this project' สไตล์ Shopee — ช่างซื้อเฉพาะ BoQ ที่อนุมัติ ผ่าน PMR ที่คุมได้ ซื้อนอกงบไม่ได้",
        ],
        "routes":["/projects/portfolio","/projects/action-center","/projects/{code}","/projects/resources","/shop/project/{code}"]})

    # 21 — Real Estate / Construction
    S.append({"t":"mod_over","family":"อสังหา & ก่อสร้าง","accent":"gold","glyph":"⌂","tag":"VERTICAL",
        "title":"ผู้รับเหมา + Developer: ประมูล→งวดงาน→โอนกรรมสิทธิ์",
        "positioning":"vertical ผู้รับเหมา + developer บนแกน PPM/P2P/AR/AP — ประมูลก่อนได้งาน, progress billing (งวดงาน) + retention, subcontractor และ property developer (units→booking→สัญญาขาย→ผ่อน→โอนกรรมสิทธิ์) พร้อม VAT/WHT ไทยและการรับรู้รายได้ถูกต้อง",
        "features":[
            ("Units & availability (RE-01)","development ของ unit (คอนโด/บ้าน/ที่ดิน), status available→reserved→contracted→transferred, ห้ามขายซ้ำ"),
            ("ประมูล→ได้งาน (PROJ-18)","bid estimate + markup %, ประเมิน→ยื่นซอง→ชนะ, award คลิกเดียว → project + BoQ ร่างจาก estimate"),
            ("งวดงาน (PROJ-16)","value ต่อ BoQ line % สะสม (บิลเฉพาะส่วนเพิ่ม, cap 100%), certify maker-checker, output VAT 7% + retention 1170"),
            ("Subcontracts (PROJ-17)","commitment บน BoQ, valuation % สะสม, certifier อิสระ → AP + retention 2440 + input VAT + WHT 3% (ภ.ง.ด.53)"),
            ("สัญญาขาย (RE-02)","ราคา = list − ส่วนลด, ดาวน์, ผ่อน, drafts ไม่โพสต์, approver อิสระ (re_contract_approve) → contract liability 2410"),
            ("โอนกรรมสิทธิ์ (RE-04)","authorised + จ่ายครบเท่านั้น, idempotent, defer 2410 → revenue 4200, relieve construction cost"),
        ]})
    S.append({"t":"mod_ctrl","family":"อสังหา & ก่อสร้าง","accent":"gold",
        "title":"ภาษีก่อสร้างไทยถูกต้อง end-to-end",
        "controls":[
            "RE-01 unit-inventory integrity (ห้าม double-book/contract); RE-02 สัญญาขาย maker-checker (R19)",
            "RE-03 ผ่อน pay-once/exact/idempotent; RE-04 transfer revenue recognition",
            "PROJ-16 progress-claim certification (R17); PROJ-17 subcontract valuation (R18); PROJ-18 tender→award",
            "permission-gated: re_sales/re_contract_approve/re_transfer/proj_billing/proj_subcon — บริษัทไม่ใช่อสังหาไม่เห็น",
        ],
        "wow":[
            "bid ที่ชนะกลายเป็นงบโครงการในคลิกเดียว — award seed project + BoQ ร่างจาก estimate ที่ตั้งราคาไว้",
            "ภาษีก่อสร้างไทยครบ end-to-end — output VAT 7%, input VAT + WHT 3% (ภ.ง.ด.53), retention รับ/จ่าย tranche release",
            "งวดงานที่ over-certify ไม่ได้ — BoQ-line สะสม บิลเฉพาะส่วนเพิ่ม cap 100%/line + certifier อิสระ",
            "unit ขายซ้ำไม่ได้ — status machine re-check ตอนอนุมัติสัญญา, เงินอยู่ contract liability ไม่รับรู้รายได้จนโอน",
        ],
        "routes":["/projects/tenders","/projects/billing","/projects/subcontracts","/realestate"]})

    # 22 — Budget / Planning / Demand
    S.append({"t":"mod_over","family":"วางแผน · FP&A & Demand","accent":"cyan","glyph":"◱","tag":None,
        "title":"FP&A + Demand ML ที่อธิบายได้",
        "positioning":"เลเยอร์ FP&A/EPM ครบ — budget maker-checker, driver-based plan, three-way variance (Budget/Forecast/Actual), encumbrance gate บนจัดซื้อ, demand ML อธิบายได้หลายโมเดล และ segment profitability — variance เป็น detective control ชั้นหนึ่งเหนือ ledger ที่โพสต์แล้ว",
        "features":[
            ("Budgets (BUD-01)","upsert ต่อ fiscal_year+account+period+cost_center, annual → 12 เดือนอัตโนมัติ, pending ตัดออกจาก variance"),
            ("Budget-vs-actual","actuals จาก posted JE เท่านั้น (IPE), material flag (≥1,000฿ และ ≥10%), review sign-off + note append-only"),
            ("Budgetary control (BUD-02)","policy off/advise/warn/block gate PR/PO approval, block ต้อง exec override + reason (audited)"),
            ("EPM plans (EPM-02)","version FSM Working→Baselined, scenarios, driver-based forecast จาก GL actuals, three-way variance"),
            ("Demand ML","9 โมเดลคลาสสิกอธิบายได้ (SMA/SES/Holt/Croston/Thai-holiday/weather), walk-forward backtest WAPE/MASE auto-select"),
            ("Profitability allocation","segment + allocation rules (driver-based), report profitability ต่อ segment"),
        ]})
    S.append({"t":"mod_ctrl","family":"วางแผน · FP&A & Demand","accent":"cyan",
        "title":"งบที่บังคับได้จริง ไม่ใช่แค่รายงาน",
        "controls":[
            "BUD-01 budget maker-checker (self-approve = SOD_VIOLATION, pending ตัดออกจาก variance)",
            "BUD-02 encumbrance gate (BUDGET_EXCEEDED, exec override + reason); EPM-01/02/03/04 version FSM + variance detective",
            "ELC-06 management variance review sign-off; GL-05 maker-checker; GOV-01 pending monitor",
        ],
        "wow":[
            "งบบังคับได้จริง — พลิก policy จาก report-only เป็น block แล้ว PR/PO เกินงบถูกหยุดที่ approval (exec override + reason)",
            "งบที่เอื้อตัวเองซ่อน overspend ไม่ได้ — งบ unapproved ตัดออกจาก variance, self-approve block แม้ Admin",
            "demand ML อธิบายได้ audit-friendly — คลาสสิก (Croston + Thai-holiday + rain) + walk-forward WAPE/MASE",
            "management variance review เก็บเป็นหลักฐาน — variance สำคัญต้อง sign-off note append-only (ELC-06)",
        ],
        "routes":["/budget","/demand","/planning","/profitability"]})

    # 23 — BI & Analytics
    S.append({"t":"mod_over","family":"BI · รายงาน & วิเคราะห์","accent":"violet","glyph":"◔","tag":None,
        "title":"BI ที่ทุก KPI drill ลง ledger",
        "positioning":"เลเยอร์ BI ที่คุมได้ — แปลง ledger + POS journal เป็น KPI/cube/scorecard/forecast ทุกตัวเลข reconcile กับต้นทาง (IPE), cache ต่อ tenant, self-serve/scheduled/streamed จาก KPI board บรรทัดเดียวถึง CFO Command Center และ query builder no-code บนสไปน์ permission+RLS เดียว",
        "features":[
            ("KPI board & cubes","MTD/YTD sales, open AR/AP, weighted pipeline, sales cube click-through drill, finance trend multi-ledger"),
            ("CFO Command Center (ELC-07)","~31 finance KPI 6 กลุ่ม + RAG + เทียบ prior/budget, drill ลง GL, trailing-12-month, MD&A narrative"),
            ("Query & NL analytics","semantic layer whitelist (measures × dimensions) — user input ไม่ถึง SQL, ถาม NL ไทย/อังกฤษ map ลง layer เดียวกัน"),
            ("Scheduled reports","subscribe report + frequency + email/LINE, cron sweep multi-instance-safe, ~20 report types + action jobs"),
            ("Live SSE (BiLive)","dashboard update สด, badge สด/ออฟไลน์, fallback 60s polling, auto-reconnect"),
            ("Insights & demand","anomaly (Z-score), replenishment ROP, restaurant menu-engineering matrix + affinity"),
        ]})
    S.append({"t":"mod_ctrl","family":"BI · รายงาน & วิเคราะห์","accent":"violet",
        "title":"ตัวเลขที่รีวิว = ตัวเลขทุกที่",
        "controls":[
            "BI-01 report reconcile ต้นทาง (IPE completeness/accuracy); BI-02 statutory PDF integrity; BI-03 parameter validation",
            "BI-04 AI/forecast read-only advisory boundary; ELC-07 management analytical review",
            "R01/ITGC-01 permission + RLS ทุก endpoint (dashboard permission-filtered)",
        ],
        "wow":[
            "ทุก KPI drill ลง ledger — current-ratio แดงกางเป็น GL rows จริง, definition เดียวป้อน dashboard+pack+scorecard",
            "NL question → governed query ไม่ใช่ raw SQL — NL และ point-and-click map ลง semantic layer เดียวกัน กันข้าม tenant",
            "demand forecast 9 โมเดล self-select + Thai-holiday & weather brain — อธิบายได้ ไม่ใช่กล่องดำ",
            "live SSE dashboard + graceful degradation — streaming + fallback polling + badge Live/Offline",
        ],
        "routes":["/finance/command-center","/query","/nl-analytics","/insights","/scheduled-reports","/restaurant-analytics"]})

    # 24 — AI
    S.append({"t":"mod_over","family":"AI · Copilot & Agent","accent":"green","glyph":"✦","tag":None,
        "title":"AI ที่ใช้ code path เดียวกับแอป — และแตะ GL ไม่ได้",
        "positioning":"เลเยอร์ LLM copilot ที่คุมได้ (Anthropic Claude) ต่อตรงกับ service layer เดียวกับ REST API — AI สืบทอด RBAC + tenant scope อัตโนมัติ อ่าน/แนะนำ/ยื่นข้อเสนอที่คนอนุมัติเท่านั้น ทำงานได้เมื่อไม่มี API key (offline-safe), redact PII ก่อนส่งออก และถูกกั้นจาก GL",
        "features":[
            ("Provider seam เดียว","จุดสร้าง Anthropic SDK จุดเดียว + injection hook ให้ scripted fake model ขับ agent loop จริงใน CI, model pinned"),
            ("Agent loop = service เดียวกับ REST","~19 read tools RBAC-gated ต่อ user — tool อันตราย (void/adjust) ไม่ถึง assistant ทั่วไป"),
            ("PDPA PII redaction","mask email/phone/เลขบัตร/ที่อยู่ ก่อนส่ง external model, opt-out ต่อบริษัท, prod ต้อง DPA acknowledged"),
            ("Agentic write-ops (propose→approve)","propose JE/PO เข้า ai_action_requests (PENDING), คน (≠ proposer) ที่มีสิทธิ์อนุมัติ แล้วจึง execute"),
            ("Copilot cite-or-refuse RAG","ตอบเฉพาะจาก KB ของ tenant พร้อม citation หรือปฏิเสธ — ไม่มั่ว, KB_MIN_SCORE threshold"),
            ("Doc-AI & NL & LINE copilot","แตกบิลเป็น AP draft, NL analytics, LINE copilot cost-routed + daily cap + confirm-first"),
        ]})
    S.append({"t":"mod_ctrl","family":"AI · Copilot & Agent","accent":"green",
        "title":"AI มองเห็น/ทำได้เท่าที่ผู้ใช้ทำได้",
        "controls":[
            "BI-04 AI read-only & advisory boundary; AIG-01..04 scored ai-eval CI benchmark + DPA gate + honest labeling",
            "SoD self-approval block บน agentic action (propose ≠ approve)",
            "honest labeling: demand-ml เป็นสถิติคลาสสิก ไม่ใช่ ML; 'AI' = governed LLM copilot เท่านั้น",
        ],
        "wow":[
            "AI ใช้ code path เดียวกับแอป — ไม่มี surface un-authed แยก, ทุก tool call = service RBAC/tenant-scoped ที่คนกด",
            "propose→approve→execute กำแพง SoD แข็ง — model ร่าง JE/PO ได้ แต่คนละคนที่มีสิทธิ์ต้องอนุมัติ ไม่มีทางแตะ ledger ตรง",
            "cite-or-refuse RAG — ตอบเฉพาะจากเอกสาร tenant พร้อม citation หรือปฏิเสธ ไม่มั่ว policy",
            "รันออฟไลน์ได้ + audit-clean — deterministic fallback + scripted-LLM CI benchmark คะแนนความถูกต้องโดยไม่ต้อง API key",
        ],
        "routes":["/assistant","/copilot","/ai-actions","/doc-ai","/nl-analytics"]})

    # 25 — Platform Customization / No-code
    S.append({"t":"mod_over","family":"Studio · No-code Customization","accent":"gold","glyph":"◨","tag":None,
        "title":"ปรับ ERP ให้เข้าธุรกิจ โดยไม่ต้องเขียนโค้ด",
        "positioning":"'Studio' no-code ~24 ความสามารถ ให้ tenant ปรับ ERP เข้าธุรกิจโดยไม่ต้องมี developer — custom fields, custom objects, form layouts, workflow/alert/automation builder, document templates, white-label theme, feature flags และคุมเมนู/โมดูลต่อบริษัท ทุกอย่าง RLS-isolated, permission-gated, audit-logged และโพสต์ GL ไม่ได้ (ยืนยันด้วย ext harness 280+ เช็ก)",
        "features":[
            ("Custom fields & objects","ฟิลด์ typed no-code บนทุก entity + สร้าง record type ใหม่ ('custom app') โดยไม่ต้องมีโมดูล"),
            ("Object/form layouts","section, 1/2 คอลัมน์, จัดลำดับ/ซ่อน, ต่อ role — resolve กับ field defs สด, ฟิลด์ใหม่โผล่อัตโนมัติ"),
            ("Workflow/alert/automation","approval หลายชั้น + SLA/escalation, alert rule metric, automation when-event-then-action (non-GL, logged)"),
            ("Document templates","designer receipt/quotation/PO/payslip + ใบกำกับ ม.86/4 & ม.86/6 — เปลี่ยนยอด/ลบฟิลด์บังคับไม่ได้"),
            ("White-label & flags","brand ทั้งแอป (สี/โลโก้), feature flags/Labs ต่อ tenant, per-tenant menu/module control (403 MODULE_DISABLED)"),
            ("AI config assistant","อธิบาย object/alert/automation เป็นภาษาธรรมชาติ → ได้ config JSON ให้รีวิวก่อน apply"),
        ]})
    S.append({"t":"mod_ctrl","family":"Studio · No-code Customization","accent":"gold",
        "title":"ปรับได้อิสระ แต่ปลอดภัยต่อ auditor",
        "controls":[
            "ไม่มี numbered RCM ใหม่ (operational) แต่ตอกย้ำ ITGC-AC-03 (RLS), AC-02 (permission), AC-10 (audit)",
            "MDM-02 bulk-import validation; AC-04 secrets AES-256-GCM at rest",
            "ext harness ยืนยันต่อ feature: no GL impact, tenant isolation, least privilege, docs-as-done",
        ],
        "wow":[
            "สร้าง custom app ทั้งตัวโดยไม่เขียนโค้ด — นิยาม object + typed fields + form layout ต่อ role + เก็บ record",
            "document template auditor-safe by construction — restyle ใบกำกับได้ แต่ฟิลด์บังคับ ม.86/4-86/6 ถูกคงไว้, ยอดแก้ไม่ได้",
            "ผ่าตัด sidebar/module ต่อ tenant — ซ่อนเมนู, จัดลำดับ, ปิดทั้งโมดูล (API-enforced) โดยไม่กระทบ tenant อื่น",
            "AI ร่าง config ได้ — อธิบาย alert/object/automation เป็นภาษาธรรมชาติ ได้ JSON พร้อม apply",
        ],
        "routes":["/custom-fields","/custom-objects","/object-layouts","/workflow","/automation","/document-templates"]})

    # 26 — Multi-tenant Platform / God + Integrations + Portal (single cards)
    S.append({"t":"cards","kicker":"เจาะลึก · แพลตฟอร์ม & ระบบนิเวศ","title":"God Console · Integrations · Customer Portal","accent":"teal","cols":3,
        "section":"เจาะลึกแต่ละโมดูล",
        "intro":"control plane SaaS หลายบริษัท + API/webhook/SSO + พอร์ทัลลูกค้า — provisioning god-only (fail-closed), API scope-gated, ทุกอย่าง RLS-isolated",
        "cards":[
            ("♛","God Console (/platform)","provision/suspend/act-as, onboarding, cross-company SaaS KPI (MRR/ARR/churn), hash-chain audit feed","teal"),
            ("⚑","Provisioning atomic","ทรานแซกชันเดียว: tenant + Admin + trial + 12 open periods + industry COA, โพสต์ได้ทันที","teal"),
            ("👁","Act-as read-only","god inspect บริษัทใดก็ได้ mutation hard-block (READONLY_IMPERSONATION), audit-logged ทุก action","cyan"),
            ("⇄","Public API v1 + Dev portal","scope-gated (catalog/inventory/orders/invoices), rate-limited, RLS, OpenAPI 3.1 auto","violet"),
            ("⛓","Webhooks & SSO/SCIM","outbound HMAC-SHA256 signed (5-min replay), OIDC PKCE + SCIM (deactivate ไม่ลบ), connector staged review","violet"),
            ("◫","Customer Portal","dashboard/POS/สต๊อก auto-reorder/track/EOD count/BoM/loyalty — mini-ERP แยก surface สะอาด","gold"),
        ]})

    return S


# ══════════════════════════════════════════════════════════════════════════════
# FULL DECK ASSEMBLY
# ══════════════════════════════════════════════════════════════════════════════

def build_specs():
    S = []

    # ── Cover ────────────────────────────────────────────────────────────────
    S.append({"t":"cover",
        "title":"Invisible ERP",
        "subtitle":"แพลตฟอร์มบริหารธุรกิจครบวงจร — ERP · POS · CRM · Loyalty ในระบบเดียว ที่ออกแบบมาเพื่อการควบคุมภายในระดับบริษัทจดทะเบียน",
        "tagline":"ควบคุมแน่น · โปร่งใส · โลคัลไลซ์ไทยเต็มรูปแบบ · พร้อมมาตรฐานสากล"})

    # ── Agenda ───────────────────────────────────────────────────────────────
    S.append({"t":"agenda","items":[
        ("0","ภาพรวมระบบ","สรุปภาพรวมและคุณค่าทางธุรกิจ"),
        ("1","สิ่งที่มีแต่ที่อื่นไม่มี","จุดแตกต่างที่เป็นข้อได้เปรียบ"),
        ("2","ระบบความปลอดภัย","ความปลอดภัย & การควบคุมภายใน"),
        ("3","โมดูลใน POS","ทุกโมดูลฝั่งหน้าร้าน"),
        ("4","โมดูลใน ERP","ทุกโมดูลฝั่งหลังบ้าน"),
        ("5","เจาะลึกแต่ละโมดูล","รายละเอียดเชิงลึกทุกโมดูล"),
        ("6","สิ่งที่ควรรู้เพิ่มเติม","การนำไปใช้ · รองรับ · ก้าวต่อไป"),
    ]})

    # ══ SECTION 0 — OVERVIEW (5) ════════════════════════════════════════════
    S.append({"t":"divider","num":"0","title":"ภาพรวมระบบ","accent":"teal",
        "subtitle":"Invisible ERP คืออะไร และสร้างคุณค่าให้ธุรกิจของคุณอย่างไร"})

    S.append({"t":"bullets","kicker":"ภาพรวม · 0.1","title":"Invisible ERP คืออะไร","section":"ภาพรวมระบบ","accent":"teal",
        "intro":"ระบบบริหารธุรกิจครบวงจรบนสถาปัตยกรรมเดียว รวมงานหลังบ้าน (ERP), หน้าร้าน (POS/ร้านอาหาร), ลูกค้าสัมพันธ์ (CRM) และสมาชิก (Loyalty) — ออกแบบมาให้ 'มองไม่เห็นความยุ่งยาก' ผู้ใช้ทำงานลื่นไหล แต่เบื้องหลังคุมเข้มระดับ SOX/ICFR",
        "bullets":[
            ("แพลตฟอร์มเดียว ครบทุกวงจร","ตั้งแต่ขายหน้าร้าน → คลัง → จัดซื้อ → ผลิต → บัญชี → ปิดงบ → ภาษี — ไม่ต้องต่อหลายระบบ"),
            ("โลคัลไลซ์ไทยเต็มรูปแบบ","VAT/WHT, ใบกำกับภาษี ม.86/4, e-Tax UBL 2.1, PromptPay, LINE OA, เขตเวลา Asia/Bangkok, สองภาษา TH/EN"),
            ("Multi-tenant SaaS แยกข้อมูลระดับฐานข้อมูล","Postgres Row-Level Security — ข้อมูลแต่ละบริษัทแยกขาดจากกัน ไม่ใช่แค่ระดับแอป"),
            ("ควบคุมภายในระดับบริษัทจดทะเบียน","282 มาตรการควบคุม, maker-checker บังคับแม้ Admin, audit trail แก้ไม่ได้ — เตรียมเข้า NASDAQ"),
            ("ปรับแต่งได้แบบ no-code + AI ในตัว","custom fields/objects, workflow builder, LLM copilot ที่กั้นจาก GL และสืบทอดสิทธิ์อัตโนมัติ"),
        ]})

    S.append({"t":"stats","kicker":"ภาพรวม · 0.2","title":"Invisible ERP ในตัวเลข","section":"ภาพรวมระบบ",
        "intro":"ขนาดและความลึกของระบบที่สะท้อนความพร้อมระดับองค์กร",
        "stats":[
            ("100+","โมดูลธุรกิจ","ครอบคลุมทุกวงจรงานในระบบเดียว"),
            ("282","มาตรการควบคุม","278 Implemented · 0 Gap — ทดสอบอัตโนมัติทุก deploy"),
            ("23","กฎแบ่งแยกหน้าที่","SoD R01–R23 ประเมินอัตโนมัติ"),
            ("110+","ชุดทดสอบ CI","re-prove ทุก control ต่อเนื่อง"),
        ],
        "footer":"ทุกตัวเลขสร้างจากซอร์สโค้ดจริง (generated) และมี CI gate ห้าม 'overclaim' — ตัวเลขที่นำเสนอพิสูจน์ได้"})

    S.append({"t":"cards","kicker":"ภาพรวม · 0.3","title":"หนึ่งแพลตฟอร์ม สี่ surface ทำงานร่วมกัน","section":"ภาพรวมระบบ","cols":2,
        "cards":[
            ("◧","POS / หน้าร้าน","ขายหน้าร้าน, ร้านอาหาร (dine-in/KDS/บุฟเฟต์), ออฟไลน์ PWA, เดลิเวอรี — ลง GL อัตโนมัติแบบบาลานซ์","cyan"),
            ("▤","ERP / หลังบ้าน","คลัง, จัดซื้อ, ผลิต, บัญชี, การเงิน, ภาษี, HR, โครงการ, งบประมาณ, BI — วงจรครบ","teal"),
            ("◎","CRM & Loyalty","pipeline/CPQ/บริการหลังการขาย + สมาชิก/แต้ม/แคมเปญ ผูก LINE OA และบัญชี GL จริง","violet"),
            ("◫","Customer Portal","พอร์ทัลลูกค้า/สาขา/ผู้ขาย — dashboard, POS, สต๊อก auto-reorder, ติดตามออเดอร์","gold"),
        ],
        "intro":"ทั้งสี่ surface ใช้ข้อมูล สิทธิ์ และการควบคุมชุดเดียวกัน — ธุรกรรมหน้าร้านไหลเข้าบัญชีและ BI ทันที ไม่มีการ sync ระหว่างระบบ"})

    S.append({"t":"cards","kicker":"ภาพรวม · 0.4","title":"คุณค่าทางธุรกิจที่ลูกค้าได้รับ","section":"ภาพรวมระบบ","cols":3,
        "cards":[
            ("↯","ลดต้นทุนระบบซ้ำซ้อน","แทนที่ POS + บัญชี + CRM + คลัง หลายระบบด้วยแพลตฟอร์มเดียว ลดค่า license และค่าเชื่อมต่อ","teal"),
            ("⛨","กันทุจริตในตัว","maker-checker, SoD, blind-count, BEC defense — ลดความเสี่ยงการรั่วไหลของเงินและสต๊อก","coral"),
            ("⚡","ปิดงบเร็วขึ้น","Close Cockpit RAG, tie-out อัตโนมัติ, balanced-by-construction — ลดวันปิดงบ","gold"),
            ("◔","ตัดสินใจด้วยข้อมูลสด","BI drill ลง ledger, live SSE KPI, demand forecast, NL analytics ภาษาไทย","violet"),
            ("✓","พร้อมตรวจสอบ/ระดมทุน","RCM 282 controls, ISO/SOC2/PDPA-ready, audit trail แก้ไม่ได้ — เพิ่มความน่าเชื่อถือ","green"),
            ("↗","เติบโตได้ไม่ติดเพดาน","หลายสาขา/หลายบริษัท/หลาย GAAP/หลายสกุลเงิน + API เปิด — ขยายธุรกิจได้ทันที","cyan"),
        ]})

    # ══ SECTION 1 — UNIQUE (3) ═══════════════════════════════════════════════
    S.append({"t":"divider","num":"1","title":"สิ่งที่ Invisible มี แต่คนอื่นไม่มี","accent":"gold",
        "subtitle":"จุดแตกต่างที่ไม่ใช่แค่ feature — แต่เป็นข้อได้เปรียบเชิงโครงสร้างที่คู่แข่งลอกยาก"})

    S.append({"t":"cards","kicker":"จุดต่าง · 1.1","title":"9 จุดแตกต่างที่หาไม่ได้จากที่อื่น","section":"สิ่งที่มีแต่ที่อื่นไม่มี","cols":3,
        "cards":[
            ("⛓","สมุดภาษี hash-chain","fiscal journal แบบ cryptographic hash chain ตามข้อกำหนดสรรพากร — แก้แถวเก่า hash ทุกแถวถัดไปพัง","cyan"),
            ("⛨","maker-checker ผูกแม้ Admin","แม้ผู้ดูแลระบบก็ approve งานตัวเองไม่ได้ ทุกจุดสัมผัสเงิน — ไม่ใช่แค่ role flag","coral"),
            ("◱","งบบังคับได้จริง","encumbrance gate หยุด PR/PO เกินงบที่ approval + BoQ commitment concurrency-safe","gold"),
            ("✦","AI กั้นจาก GL","LLM copilot ใช้ code path เดียวกับแอป สืบทอดสิทธิ์ + propose→approve เท่านั้น แตะบัญชีตรงไม่ได้","green"),
            ("⧉","Multi-GAAP + IFRS 9/15/16","parallel ledger TFRS/TAX/IFRS + งบรวม dual-rate/CTA + rev-rec 5-step + lease + ตราสารการเงิน","violet"),
            ("◉","ออฟไลน์ที่ทำงานจริง","PWA ขายต่อได้ทั้ง quick-sale & dine-in ขณะเน็ตล่ม + LAN hub replay exactly-once","cyan"),
            ("★","แต้ม = หนี้สินที่ลงบัญชี","loyalty ผูก GL 2250 ด้วย TFRS-15 + coalition intercompany clearing atomic","gold"),
            ("◆","LINE-native ครบวงจร","สั่งซื้อ/อนุมัติ/รับของ/สมาชิก/copilot ผ่าน LINE โดยการควบคุมไม่หาย","green"),
            ("✓","ควบคุมที่ทดสอบตัวเอง","282 controls ที่ 98% มี ToE harness รันทุก deploy + golden-master gate","teal"),
        ]})

    S.append({"t":"compare","kicker":"จุดต่าง · 1.2","title":"Invisible ERP เทียบกับ ERP ทั่วไป","section":"สิ่งที่มีแต่ที่อื่นไม่มี",
        "rows":[
            ("การแยกข้อมูลหลายบริษัท","Postgres RLS ระดับ DB + fail-closed boot","WHERE clause ระดับแอป"),
            ("การควบคุมภายใน (SOX/ICFR)","282 controls + ToE รันทุก deploy","เอกสาร narrative นิ่ง ๆ"),
            ("maker-checker","บังคับแม้ Admin ทุกจุดสัมผัสเงิน","อนุมัติเองได้ถ้าเป็นผู้ดูแล"),
            ("ภาษีไทย","e-Tax UBL 2.1 + XAdES, ภ.พ.30/36/ธ.40","VAT พื้นฐาน export CSV"),
            ("รับรู้รายได้","TFRS/IFRS 15 ครบ 5 waves","straight-line defer"),
            ("AI","copilot สืบทอดสิทธิ์ + กั้นจาก GL","bolt-on chatbot แยก"),
            ("ออฟไลน์","PWA + LAN hub replay exactly-once","ต้องออนไลน์ตลอด"),
        ]})

    S.append({"t":"bullets","kicker":"จุดต่าง · 1.3","title":"ทำไมจุดต่างเหล่านี้ 'ลอกยาก'","section":"สิ่งที่มีแต่ที่อื่นไม่มี","accent":"gold","twocol":True,
        "intro":"จุดแตกต่างของ Invisible ไม่ใช่ feature ผิวเผิน แต่เป็นการตัดสินใจเชิงสถาปัตยกรรมที่ฝังอยู่ในทุกบรรทัดโค้ด — คู่แข่งต้องเขียนใหม่ทั้งระบบจึงจะตามได้",
        "bullets":[
            ("การควบคุมเป็นค่าตั้งต้น (fail-closed)","ระบบ 'ปฏิเสธที่จะบูต' ถ้าตั้งค่าเสี่ยงข้อมูลรั่ว — ความปลอดภัยปิดโดยบังเอิญไม่ได้"),
            ("ควบคุมที่พิสูจน์ตัวเอง","110+ harness re-perform ทุก control ทุก deploy — ไม่ใช่ sampling ปีละครั้ง"),
            ("balanced-by-construction","ทุก JE บาลานซ์และ idempotent โดยโครงสร้าง — ข้อมูลบัญชีเพี้ยนเงียบไม่ได้"),
            ("golden-master gate","logic การเงินถูกล็อกด้วย CI — เปลี่ยนผลลัพธ์ ledger/costing โดยไม่ตั้งใจ = build แดง"),
            ("ซื่อสัตย์โดยบังคับ","CI gate ห้ามเขียนคำว่า 'audit-ready/100% compliant' โดยไม่มีเงื่อนไข — auditor เชื่อถือ"),
            ("โลคัลไลซ์ระดับกฎหมาย","ไม่ใช่แค่แปลภาษา — e-Tax XAdES, TIS-620, พ.ศ., ม.86/4 ยื่นได้จริง"),
            ("แกนข้อมูลเดียว","POS→บัญชี→BI ไหลทันที ไม่มี ETL/sync — ตัวเลขที่เห็นคือตัวเลขจริง real-time"),
            ("multi-GAAP โพสต์ครั้งเดียว","TFRS/TAX/IFRS แยกเฉพาะ adjustment — book-tax difference สะอาด วัดได้"),
        ]})

    # ══ SECTION 2 — SECURITY (5) ═════════════════════════════════════════════
    S.append({"t":"divider","num":"2","title":"ระบบความปลอดภัย","accent":"coral",
        "subtitle":"ออกแบบมาเพื่อผ่าน penetration test และการตรวจสอบระดับบริษัทมหาชน — fail-closed by default"})

    S.append({"t":"stats","kicker":"ความปลอดภัย · 2.1","title":"ความปลอดภัยในตัวเลข","section":"ระบบความปลอดภัย",
        "intro":"ตรวจสอบโดยอิสระ 2 ครั้งในปี 2026 — internal pentest + third-party review, แก้ครบทุกข้อ",
        "stats":[
            ("282","controls (RCM)","278 Implemented · 4 Partial · 0 Gap"),
            ("22","findings แก้ครบ","third-party review H-1..H-4/M-1/L-1..L-12 merged 100%"),
            ("23","SoD rules","ประเมินอัตโนมัติต่อสิทธิ์จริงของผู้ใช้"),
            ("344","tables RLS-isolated","แยกข้อมูลระดับ Postgres engine"),
        ],
        "footer":"pentest ภายในระบุ 1 Critical + 6 High + 8 Medium — remediate และ re-verify สด ครบทุกข้อ"})

    S.append({"t":"two_panel","family":"","accent":"coral",
        "kicker":"ความปลอดภัย · 2.2","title":"การแยกข้อมูลหลายบริษัท (Multi-Tenant Isolation)","section":"ระบบความปลอดภัย",
        "left":("แยกที่ระดับฐานข้อมูล ไม่ใช่ระดับแอป","⛁","teal",[
            ("FORCE Row-Level Security","ทุกตารางมี RLS policy บน tenant_id, FORCE — แม้เจ้าของตารางก็อยู่ใต้กฎ"),
            ("Transaction-local context","GUC ตั้งด้วย SET LOCAL — tenant context ไม่รั่วข้าม pooled connection"),
            ("tenant_id จาก JWT ที่เซ็นเท่านั้น","ปลอมผ่าน header/body ไม่ได้ (pentest-verified)"),
            ("Live role sourcing (L-3)","อ่าน role จาก DB สดทุก request — downgrade แล้วสิทธิ์หายทันที"),
        ]),
        "right":("Fail-closed — ระบบปฏิเสธที่จะบูตถ้าเสี่ยงรั่ว","⛨","coral",[
            ("Boot check H-3","prod ปฏิเสธบูตถ้า DB role เป็น superuser หรือมี BYPASSRLS"),
            ("Non-superuser ierp_app","prod ต่อด้วย role NOSUPERUSER NOBYPASSRLS — ไม่มี opt-out"),
            ("Boot check H-4","ปฏิเสธบูตถ้ามี >1 tenant ใต้ single-company mode"),
            ("CI parity gate (pg-core)","พิสูจน์ isolation บน Postgres จริงทุก build ด้วย role รูปแบบเดียวกับ prod"),
        ])})

    S.append({"t":"cards","kicker":"ความปลอดภัย · 2.3","title":"Application Security — ปิดช่องโหว่ OWASP","section":"ระบบความปลอดภัย","cols":3,
        "intro":"ผ่านการ hardening ตาม OWASP Top 10 + API Security Top 10 แล้วตรวจสอบโดยผู้เชี่ยวชาญอิสระ ค่าตั้งต้นเป็น fail-closed",
        "cards":[
            ("◈","CSP nonce ต่อ request (M-1)","script-src nonce + strict-dynamic — inline script ที่ถูก inject ไม่มี nonce = ถูกปฏิเสธ","coral"),
            ("⇢","SSRF guard (H-1)","block loopback/RFC1918/metadata + IPv6-mapped hex, re-validate ตอนส่ง (DNS-rebind safe)","coral"),
            ("⛓","HMAC webhook (L-1/L-2)","verify HMAC-SHA256 over raw body + replay window, timingSafeEqual, fail-closed","violet"),
            ("🔑","API key = maker-checker (H-2)","key พก created_by, self-approve ไม่ได้, ถูกบังคับเป็น non-Admin + own tenant","violet"),
            ("🔐","Secrets เข้ารหัส at rest","AES-256-GCM + HKDF keyring + rotation (17 คอลัมน์), SCIM token เก็บ hash","gold"),
            ("⏱","Session & brute-force","JWT httpOnly + CSRF double-submit, token 8h→1h + revocation ทันที, login lockout + rate limit","teal"),
        ]})

    S.append({"t":"two_panel","family":"","accent":"gold",
        "kicker":"ความปลอดภัย · 2.4","title":"SOX / ICFR & การควบคุมภายใน","section":"ระบบความปลอดภัย",
        "left":("Risk-Control Matrix ที่ทดสอบตัวเอง","≣","gold",[
            ("282 controls แมป COSO","แต่ละตัวมี 17 ฟิลด์ + ToE reference, generated จากโค้ด ไม่ hand-edit"),
            ("110+ ToE harness","re-perform control ทุก CI run — fail = block merge, control regression ไม่หลุด"),
            ("maker-checker ทั่วแอป","GL/payroll/stocktake/3-way/CPQ/NCR/treasury — approver ≠ initiator"),
            ("Control Console ในแอป","auditor เปิด RCM catalogue + evidence ได้ในตัวสินค้า (/controls/rcm)"),
        ]),
        "right":("23 SoD rules + override 2 คน","⚖","violet",[
            ("R01–R23 ประเมินสิทธิ์จริง","block ตอน grant (SOD_CONFLICT) + detective report"),
            ("ตัวอย่าง high-risk","R02 vendor master ≠ AP pay, R08 บันทึกขาย ≠ คืนเงิน, R14 ตั้งรางวัล ≠ redeem"),
            ("override เป็น maker-checker","justified override staged, apply โดยคนละคน (≠ requester/target)"),
            ("golden master","deep-compare ledger/procurement/BI กับ baseline — drift = CI แดง"),
        ])})

    S.append({"t":"cards","kicker":"ความปลอดภัย · 2.5","title":"ITGC · Audit Trail · Compliance","section":"ระบบความปลอดภัย","cols":3,
        "cards":[
            ("▤","Audit trail hash-chained","append-only, UPDATE/DELETE ถูก DB trigger ปฏิเสธ, verify endpoint ชี้จุดแรกที่ chain พัง","coral"),
            ("⇄","Field-level change log","ภาพ OLD→NEW บน 7 ตารางการเงินหลักที่ DB layer — app code ข้ามไม่ได้","coral"),
            ("♻","Access recertification","UAR รายไตรมาส — revoke แล้วลบสิทธิ์จริง + bump token watermark, freeze เป็นหลักฐาน","teal"),
            ("🛡","MFA + least privilege","TOTP บังคับ role การเงิน, POS-PIN ห้าม role privileged, Admin grant เฉพาะ platform owner","teal"),
            ("🌐","ISO 27001 · SOC 2 · PDPA","evidence base เดียวป้อน 4 frameworks; DSAR 30 วัน, RoPA, erasure ที่ไม่พัง audit chain","violet"),
            ("⚙","Change mgmt & Ops","PR review + branch protection, deployer ≠ author (CI-enforced), backup + restore drill + DR/BCP","gold"),
        ],
        "intro":"ITGC 34 controls (Access 22 / Change 5 / SDLC 3 / Ops 4) — ฐานที่ auditor ตรวจก่อนจะเชื่อ automated control ใด ๆ"})

    # ══ SECTION 3 — POS MODULES (2) ══════════════════════════════════════════
    S.append({"t":"divider","num":"3","title":"โมดูลทั้งหมดใน POS","accent":"cyan",
        "subtitle":"ทุกโมดูลฝั่งหน้าร้าน — ขาย, ร้านอาหาร, กะ/เงินสด, ร้าน & อุปกรณ์"})

    S.append({"t":"cards","kicker":"POS · 3.1","title":"ฝั่งขาย & ร้านอาหาร","section":"โมดูล POS","cols":4,
        "cards":[
            ("◧","Register","POS สัมผัส + PWA","cyan"),("▤","Orders","จัดการออเดอร์","cyan"),
            ("↺","Returns","คืนสินค้า","green"),("₿","Refund Auth","อนุมัติคืนเงิน","coral"),
            ("▦","Gift Cards","บัตรของขวัญ","gold"),("⎙","Print","พิมพ์ใบเสร็จ","teal"),
            ("⊞","Tables","ผังโต๊ะ","cyan"),("◷","Reservations","จองโต๊ะ/คิว","violet"),
            ("⚑","KDS","จอครัว","coral"),("≡","Menu","เมนู & modifier","teal"),
            ("◔","Buffet","บุฟเฟต์ต่อหัว","gold"),("◆","Tips","ทิป & tip pool","green"),
            ("▣","POS Control","คุมหน้าร้าน","cyan"),("₿","Till","ลิ้นชัก/กะ","gold"),
            ("◱","Close of Day","ปิดวัน Z-report","teal"),("🔑","POS PIN","PIN quick-login","violet"),
        ],
        "intro":"16 โมดูลฝั่งขาย — จัดกลุ่ม frontline · dining · shift ทุกโมดูลลง GL อัตโนมัติและอยู่ใต้ SoD หน้าร้าน"})

    S.append({"t":"cards","kicker":"POS · 3.2","title":"ร้าน & อุปกรณ์ + วิเคราะห์","section":"โมดูล POS","cols":4,
        "cards":[
            ("⚠","Claims","เคลมสินค้า","coral"),("⇆","Delivery","จัดส่ง","violet"),
            ("◫","Channels","แอกกริเกเตอร์","violet"),("⌗","Peripherals","อุปกรณ์","teal"),
            ("▭","Terminals","เครื่องรูดบัตร","gold"),("◈","Payment Accounts","บัญชีรับเงิน","cyan"),
            ("◔","Food Cost","ต้นทุนอาหาร","gold"),("◕","Restaurant Analytics","วิเคราะห์ร้าน","violet"),
            ("⊞","Production Plan","แผนครัว","cyan"),("★","POS Ops (Loyalty)","สมาชิกหน้าร้าน","gold"),
            ("₧","POS Fiscal","สมุดภาษี e-Tax","coral"),("◨","Shop/Requisition","สั่งของเข้าร้าน","teal"),
        ],
        "intro":"ร้าน & อุปกรณ์ + วิเคราะห์ร้านอาหาร (menu engineering, food cost) — เชื่อมกับคลัง จัดซื้อ และ loyalty แบบไร้รอยต่อ"})

    # ══ SECTION 4 — ERP MODULES (3) ══════════════════════════════════════════
    S.append({"t":"divider","num":"4","title":"โมดูลทั้งหมดใน ERP","accent":"teal",
        "subtitle":"ทุกโมดูลฝั่งหลังบ้าน จัดเป็น 10 โดเมนหลัก — ขาย, ซัพพลายเชน, การเงิน, HR, โครงการ, วางแผน, ควบคุม, AI, ระบบ"})

    S.append({"t":"cards","kicker":"ERP · 4.1","title":"ขาย & ลูกค้า · ซัพพลายเชน","section":"โมดูล ERP","cols":4,
        "cards":[
            ("◎","CRM Workspace","kanban/deal/account","violet"),("👥","Customer Master","ทะเบียนลูกค้า 360","violet"),
            ("📣","Marketing","แคมเปญ & ROI","coral"),("✍","CPQ","ใบเสนอราคา","violet"),
            ("🛟","Service & Warranty","บริการ/ประกัน","teal"),("★","Loyalty (11 จอ)","สมาชิก/แต้ม/gamify","gold"),
            ("₵","Pricing","ราคา & โปรโมชัน","coral"),("🏪","Branches","สาขา","teal"),
            ("📦","Inventory / WMS","สต๊อก/คลัง 3D","cyan"),("📋","Stocktake/Cycle","นับสต๊อก","cyan"),
            ("🚚","Transfer/Receiving","โอน/รับของ","cyan"),("🧮","Costing/Landed","ต้นทุน","gold"),
            ("🛒","Procurement/PR","จัดซื้อ/คำขอ","teal"),("🤝","Suppliers/RFQ","ผู้ขาย/สอบราคา","teal"),
            ("🏭","Manufacturing/BOM","ผลิต/สูตร","violet"),("◇","Quality (NCR/CAPA)","คุณภาพ","coral"),
        ]})

    S.append({"t":"cards","kicker":"ERP · 4.2","title":"การเงิน · บัญชี · ภาษี","section":"โมดูล ERP","cols":4,
        "cards":[
            ("₿","Finance AR/AP","ลูกหนี้/เจ้าหนี้","teal"),("👤","Customer/Vendor Cards","การ์ด statement","teal"),
            ("💸","Disbursements","จ่ายเงิน","coral"),("🛡","Credit Hold","คุมเครดิต","coral"),
            ("≣","Accounting/GL","บัญชีแยกประเภท","gold"),("🌳","Chart of Accounts","ผังบัญชี","gold"),
            ("◕","Revenue Rec","รับรู้รายได้","green"),("▣","Fixed Assets","สินทรัพย์ถาวร","cyan"),
            ("⚖","Leases (IFRS16)","สัญญาเช่า","cyan"),("🧾","Deferred Tax","ภาษีเงินได้รอตัด","violet"),
            ("🏦","Bank/Reconciliation","ธนาคาร/กระทบยอด","teal"),("✔","Approvals","อนุมัติ","gold"),
            ("📊","Command Center","CFO cockpit","violet"),("🏛","Consolidation","งบรวม","violet"),
            ("₧","Tax (VAT/WHT/e-Tax)","ภาษีไทย","coral"),("⛁","Treasury","เทรเชอรี","teal"),
        ]})

    S.append({"t":"cards","kicker":"ERP · 4.3","title":"HR · โครงการ · วางแผน · ควบคุม · AI · ระบบ","section":"โมดูล ERP","cols":4,
        "cards":[
            ("👤","HCM/Org","บุคลากร/องค์กร","violet"),("🎯","Performance","ประเมินผล","violet"),
            ("💼","Payroll","เงินเดือน","gold"),("🪪","ESS","self-service","teal"),
            ("📁","Projects/PPM","โครงการ","teal"),("🏗","Real Estate","อสังหา/ก่อสร้าง","gold"),
            ("🎛","Portfolio/PMO","พอร์ตโฟลิโอ","teal"),("🎯","Planning/Budget","วางแผน/งบ","cyan"),
            ("📈","Demand/Profitability","พยากรณ์/กำไร","cyan"),("📊","BI/Query/NL","วิเคราะห์","violet"),
            ("🛡","Controls/SoD/Audit","ควบคุม/ตรวจสอบ","coral"),("🏛","Governance","ธรรมาภิบาล","coral"),
            ("🤖","AI/Copilot/Actions","ผู้ช่วย AI","green"),("🗂","Master Data","ข้อมูลหลัก","teal"),
            ("⚙","Studio/No-code","ปรับแต่ง","gold"),("🔌","Connectors/API/SSO","เชื่อมต่อ","violet"),
        ]})

    # ══ SECTION 5 — DEEP DIVES (50) ══════════════════════════════════════════
    S.append({"t":"divider","num":"5","title":"เจาะลึกแต่ละโมดูล","accent":"violet",
        "subtitle":"รายละเอียดเชิงลึก ความสามารถจริง การควบคุม และจุดเด่นของแต่ละโมดูล พร้อม control ID อ้างอิงได้"})
    S.extend(_deep_dive())

    # ══ SECTION 6 — OTHERS (8) ═══════════════════════════════════════════════
    S.append({"t":"divider","num":"6","title":"สิ่งที่ควรรู้เพิ่มเติม","accent":"gold",
        "subtitle":"การนำไปใช้ · สถาปัตยกรรม · แพ็กเกจ · การรองรับ · ก้าวต่อไป"})

    S.append({"t":"bullets","kicker":"เพิ่มเติม · 6.1","title":"การนำไปใช้ & Onboarding","section":"สิ่งที่ควรรู้เพิ่มเติม","accent":"teal","twocol":True,
        "intro":"ออกแบบให้เริ่มใช้ได้เร็ว ด้วยการ provisioning แบบ atomic และเครื่องมือย้ายข้อมูลในตัว",
        "bullets":[
            ("Provisioning atomic","ทรานแซกชันเดียว: tenant + Admin + trial 14 วัน + 12 open periods + industry COA — โพสต์ได้ทันที"),
            ("Industry COA templates","restaurant/retail/distribution/services/general materialise ตอน signup"),
            ("First-run checklist & starter pack","แนะนำ setup ทีละขั้น + HQ branch idempotent"),
            ("ย้ายข้อมูล registry-driven","import/export CSV/xlsx ทุก entity, dry-run validate → preview → commit, per-row error"),
            ("Opening balances maker-checker","ยอดยกมา go-live ผ่าน GL-05 เดียวกัน — material ที่สุดไม่ถูก seed คนเดียว"),
            ("Onboarding 3 ทาง","direct create / invite link / request-access queue — public signup ปิดใน prod"),
            ("Doc-sync policy","เอกสาร (narrative/user manual/UAT) อัปเดตพร้อมโค้ดเสมอ — เป็น first-class deliverable"),
            ("Cutover runbook","มี runbook + control-test harness สำหรับ go-live"),
        ]})

    S.append({"t":"cards","kicker":"เพิ่มเติม · 6.2","title":"สถาปัตยกรรม · ความน่าเชื่อถือ · การปฏิบัติการ","section":"สิ่งที่ควรรู้เพิ่มเติม","cols":3,
        "cards":[
            ("⛭","Stack ทันสมัย","NestJS (Fastify) API + Next.js web + Drizzle ORM + PostgreSQL multi-tenant","teal"),
            ("♻","Backup + restore drill","backup อัตโนมัติ + สคริปต์ restore ที่ทดสอบจริง (ITGC-OP-01)","teal"),
            ("🌊","DR/BCP มี RTO/RPO","data <30 นาที RTO / 1 ชม. RPO, region <4 ชม. (ITGC-OP-02)","violet"),
            ("📡","Monitoring & alerting","สัญญาณ always-on + Sentry/OTel, dead-letter alert + stuck-job reaper","violet"),
            ("🚦","CI gates เข้ม","typecheck + build + ~110 harness + golden-master + ratchets ก่อน merge","gold"),
            ("🔁","Idempotent by design","posting ซ้ำไม่ double-post, atomic transaction ทุก multi-table mutation","coral"),
        ]})

    S.append({"t":"bullets","kicker":"เพิ่มเติม · 6.3","title":"แพ็กเกจ & ความยืดหยุ่น","section":"สิ่งที่ควรรู้เพิ่มเติม","accent":"gold",
        "intro":"ระบบเป็นโมดูลาร์จริง — เปิด/ปิดโมดูล, feature flags, และปรับ surface ต่อบริษัทได้",
        "bullets":[
            ("Per-tenant module control","ปิด/เปิดทั้งโมดูลต่อบริษัท (API-enforced 403 MODULE_DISABLED) โดยไม่กระทบบริษัทอื่น"),
            ("Feature flags / Labs tier","โมดูลใหม่เป็น LABS ปิดเป็น default เปิดเมื่อพร้อม"),
            ("Vertical packs","construction/real-estate, restaurant, retail — เปิดเฉพาะที่ใช้ (permission-gated, ไม่เห็นถ้าไม่มีสิทธิ์)"),
            ("White-label","brand ทั้งแอป (สี/โลโก้/tagline) + document templates ต่อบริษัท"),
            ("SaaS metrics ในตัว","MRR/ARR/ARPU/churn/plan mix — สำหรับ operator ที่ให้บริการต่อ"),
        ]})

    S.append({"t":"cards","kicker":"เพิ่มเติม · 6.4","title":"ระบบนิเวศ & การเชื่อมต่อ","section":"สิ่งที่ควรรู้เพิ่มเติม","cols":3,
        "cards":[
            ("⇄","Public API v1 + Dev portal","scope-gated, rate-limited, RLS, OpenAPI 3.1 — BI tool อ่านเฉพาะ tenant ตน","violet"),
            ("⛓","Webhooks HMAC-signed","po.approved/rejected/alert.fired, 5-min replay window, secret เข้ารหัส","violet"),
            ("🔗","SSO + SCIM","OIDC (Azure AD/Okta/Google) PKCE + SCIM lifecycle, leaver deactivate ไม่ลบ","teal"),
            ("💬","Messaging","LINE OA + email + SMS — alerts, scheduled reports, marketing","green"),
            ("🍔","Delivery marketplaces","Grab/LINE MAN/Foodpanda/Robinhood — menu-sync + auto-86","gold"),
            ("🌏","Localization packs","หลายประเทศ CoA/tax/locale, e-invoice TH/MY/SG adapters (fail-closed honesty)","cyan"),
        ]})

    S.append({"t":"bullets","kicker":"เพิ่มเติม · 6.5","title":"เอกสาร · การรองรับ · คุณภาพ","section":"สิ่งที่ควรรู้เพิ่มเติม","accent":"teal","twocol":True,
        "intro":"เอกสารเป็น first-class deliverable — เตรียมสำหรับการตรวจสอบ ISO/SOX และการใช้งานจริง",
        "bullets":[
            ("Process narratives 33 วงจร","ISO-style ต่อ cycle พร้อม Mermaid workflow + control matrix + revision history"),
            ("User manuals 20+ โมดูล","route, สิทธิ์ที่ต้องใช้, ขั้นตอน, control callout, troubleshooting/FAQ"),
            ("UAT + traceability matrix","test case positive + negative/control, ผูกกับ control ID"),
            ("RCM + readiness plans","COSO ICFR plan, ISO 27001 gap, SOC 2 readiness, PDPA, PCI scope"),
            ("Honest control status","ระบุชัด 'Implemented ≠ externally attested' — โปร่งใสต่อ auditor"),
            ("สองภาษา TH/EN","i18n framework จริง (th/en/ms/vi/id), per-user language picker"),
            ("In-app Control Console","auditor เปิด RCM catalogue + evidence ในตัวสินค้า"),
            ("Audit Viewer","อ่าน audit log + CSV export, RLS-scoped, filterable"),
        ]})

    S.append({"t":"stats","kicker":"เพิ่มเติม · 6.6","title":"ทำไมต้อง 'ตอนนี้' — ความพร้อมเชิงกลยุทธ์","section":"สิ่งที่ควรรู้เพิ่มเติม",
        "intro":"Invisible ERP ไม่ใช่แค่ระบบปฏิบัติงาน แต่เป็นสินทรัพย์เชิงกลยุทธ์สำหรับการเติบโตและการระดมทุน",
        "stats":[
            ("4","frameworks พร้อม","SOX · SOC 2 · ISO 27001 · PDPA จาก evidence base เดียว"),
            ("NASDAQ","เตรียมเข้าตลาด","codebase ICFR-first, EGC timeline โปร่งใส"),
            ("3","GAAP ขนาน","TFRS · TAX · IFRS โพสต์ครั้งเดียว"),
            ("100%","การควบคุมทดสอบได้","98% controls มี ToE harness รันต่อเนื่อง"),
        ],
        "footer":"ควบคุมภายในที่แข็งแรงตั้งแต่วันแรก = ลดต้นทุน remediation, เร่งการตรวจสอบ, และเพิ่มมูลค่าองค์กร"})

    S.append({"t":"cards","kicker":"เพิ่มเติม · 6.7","title":"สรุป: 6 เหตุผลที่ CFO/ผู้บริหารเลือกเรา","section":"สิ่งที่ควรรู้เพิ่มเติม","cols":3,
        "cards":[
            ("✓","พิสูจน์ได้ ไม่ใช่คำโฆษณา","282 controls, 98% ทดสอบอัตโนมัติ, 0 gap — ตัวเลข generated จากโค้ด","green"),
            ("⛁","แยกข้อมูลที่ปฏิเสธบูตถ้าเสี่ยง","multi-tenant RLS ระดับ DB + fail-closed — ปิดความปลอดภัยโดยบังเอิญไม่ได้","teal"),
            ("🛡","ผ่านการตรวจสอบภายนอก","22 findings ปิดครบ + pentest remediate re-verified","coral"),
            ("▤","audit trail รอด PDPA erasure","hash-chain integrity + right-to-be-forgotten อยู่ด้วยกันได้","violet"),
            ("🌐","evidence เดียว 4 มาตรฐาน","SOX + SOC 2 + ISO 27001 + PDPA — ลดต้นทุน compliance มหาศาล","gold"),
            ("🤝","ซื่อสัตย์โดยออกแบบ","CI gate ห้าม overclaim — สิ่งที่ auditor เชื่อถือที่สุด","cyan"),
        ]})

    S.append({"t":"bullets","kicker":"เพิ่มเติม · 6.8","title":"สรุปภาพรวมทั้งหมด","section":"สิ่งที่ควรรู้เพิ่มเติม","accent":"teal",
        "intro":"Invisible ERP = แพลตฟอร์มเดียวที่รวมการดำเนินงาน การเงิน และการควบคุมภายในระดับบริษัทมหาชน สำหรับธุรกิจไทยที่ต้องการเติบโตอย่างมั่นคง",
        "bullets":[
            ("ครบวงจร","POS + ERP + CRM + Loyalty + Portal บนแกนข้อมูลและสิทธิ์เดียว — ไม่มี sync ไม่มีรอยต่อ"),
            ("คุมแน่น","maker-checker ผูกแม้ Admin, 23 SoD rules, audit trail แก้ไม่ได้, 282 controls ทดสอบตัวเอง"),
            ("ไทยแท้","e-Tax XAdES, ภ.พ.30/36/ธ.40, PromptPay, LINE-native, พ.ศ./TIS-620 — ยื่นได้จริง"),
            ("มาตรฐานสากล","IFRS 9/15/16, multi-GAAP, งบรวม dual-rate, พร้อม ISO/SOC2/PDPA และเส้นทาง NASDAQ"),
            ("ฉลาด & ปรับได้","AI copilot กั้นจาก GL, BI drill ลง ledger, no-code Studio ปรับเข้าธุรกิจได้เอง"),
        ]})

    # ── Closing ──────────────────────────────────────────────────────────────
    S.append({"t":"closing","title":"พร้อมยกระดับธุรกิจของคุณ",
        "subtitle":"Invisible ERP — ระบบที่ 'มองไม่เห็น' ความยุ่งยาก แต่ควบคุมทุกอย่างไว้แน่นหนา ให้คุณโฟกัสที่การเติบโต",
        "contacts":[
            ("นัดหมาย Demo:","ทีมงาน Invisible ERP พร้อมสาธิตระบบจริงกับข้อมูลของคุณ"),
            ("อีเมล:","hello@invisible-erp.com"),
            ("เว็บไซต์:","www.invisible-erp.com"),
        ]})

    return S


if __name__ == "__main__":
    specs = build_specs()
    from collections import Counter
    c = Counter(s["t"] for s in specs)
    print(f"total slides: {len(specs)}")
    for k, v in c.most_common():
        print(f"  {k}: {v}")

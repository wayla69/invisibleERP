# -*- coding: utf-8 -*-
"""Bilingual (TH/EN) content for the Invisible ERP customer deck, authored as
generator-agnostic specs. Both the PPTX (light pastel deck) and the PDF (light
whitepaper) consume this same list.

Set the language with set_lang('th'|'en') before calling build_specs().
Every user-facing string is wrapped in T('<thai>', '<english>').

accent keys: teal, cyan, violet, gold, green, coral
"""

LANG = "th"
def set_lang(l):
    global LANG
    LANG = "en" if str(l).lower().startswith("en") else "th"
def T(th, en):
    return en if LANG == "en" else th


# ══════════════════════════════════════════════════════════════════════════════
# SECTION 5 — module deep dives (bilingual)
# ══════════════════════════════════════════════════════════════════════════════
def _deep_dive():
    S = []

    # 1 — POS & Restaurant
    S.append({"t":"mod_over","accent":"cyan","glyph":"◧","tag":T("เรือธง","FLAGSHIP"),
        "family":T("การขายหน้าร้าน และร้านอาหาร","Point of Sale & Restaurant"),
        "title":T("ระบบขายหน้าร้านและบริหารร้านอาหารระดับเต็มบริการ",
                  "A full-service point of sale for retail and restaurants"),
        "positioning":T("รองรับการบริการที่โต๊ะระดับรายที่นั่ง จอแสดงผลในครัว การสั่งอาหารด้วยตนเองผ่าน QR และการชำระเงินด้วยพร้อมเพย์ ทำงานต่อเนื่องแม้อินเทอร์เน็ตขัดข้อง และบันทึกทุกการขายลงบัญชีแยกประเภทโดยอัตโนมัติในรูปแบบสมุดภาษีที่ตรวจแก้ย้อนหลังไม่ได้ตามข้อกำหนดของกรมสรรพากร",
                        "It handles seat-level dine-in service, a kitchen display system, QR self-ordering and PromptPay payment, keeps selling through an internet outage, and posts every sale to the general ledger automatically — into a tamper-evident fiscal journal that meets the Revenue Department's unalterable-record requirement."),
        "features":[
            (T("บริการที่โต๊ะระดับที่นั่ง","Seat-level dine-in"),
             T("สั่งแยกตามที่นั่งและคอร์ส ส่งครัวตามลำดับ รวมยอดรายที่นั่ง และแยกบิลตามที่นั่งได้ในคลิกเดียว","Order by seat and course, fire to the kitchen in sequence, subtotal per seat, and split the bill by seat in one tap.")),
            (T("จอแสดงผลในครัว (KDS)","Kitchen Display System"),
             T("ติดตามสถานะอาหารพร้อมนาฬิกาแจ้งเตือนเวลาปรุงเกินกำหนด รองรับการเรียกคืนรายการและมุมมองภาระงานต่อสถานี","Live order states with prep-time alerts, item recall, and an expo/station-load view of kitchen workload.")),
            (T("สั่งเองผ่าน QR และพร้อมเพย์","QR self-order & PromptPay"),
             T("ลูกค้าสแกนที่โต๊ะเพื่อสั่งและชำระเอง ระบบคำนวณราคาฝั่งเซิร์ฟเวอร์ทั้งหมด ลูกค้าจึงแก้ไขราคาไม่ได้","Guests scan, order and pay themselves; every price is computed server-side, so it cannot be tampered with.")),
            (T("ผังร้านและการจัดการโต๊ะ","Floor plan & table ops"),
             T("จัดวางโต๊ะและโซนได้อิสระ ย้าย รวม และโอนบิลระหว่างโต๊ะ พร้อมรายงานยอดขายแยกตามห้อง","Arrange tables and zones freely; move, merge and transfer checks, with revenue reported by room.")),
            (T("บุฟเฟต์และแยกบิล","Buffet & split bill"),
             T("คิดราคาต่อหัวพร้อมค่าปรับเกินเวลา แยกบิลแบบเท่ากัน ตามรายการ หรือตามที่นั่ง โดยแต่ละบิลออกใบกำกับภาษีของตนเอง","Per-head buffet pricing with overtime fees; split equally, by item or by seat, each with its own tax invoice.")),
            (T("ประวัติลูกค้าและการแพ้อาหาร","Guest profile & allergens"),
             T("จดจำเมนูโปรดและข้อมูลการแพ้อาหาร โดยแสดงเตือนบนตั๋วครัวแบบเรียลไทม์ และลบทันทีเมื่อลูกค้าถอนความยินยอม","Remembers favourites and allergies, flags them live on every kitchen ticket, and removes them the moment consent is withdrawn.")),
        ]})
    S.append({"t":"mod_ctrl","accent":"cyan",
        "family":T("การขายหน้าร้าน และร้านอาหาร","Point of Sale & Restaurant"),
        "title":T("ความถูกต้องของเงินสดและการป้องกันการทุจริตหน้าร้าน","Cash integrity and front-of-house fraud prevention"),
        "controls":[
            T("REST-02 — สมุดภาษีร้อยเรียงด้วยลายเซ็นดิจิทัลแบบต่อเนื่อง การแก้ไขรายการเก่าจะทำให้ค่าตรวจสอบของทุกรายการถัดไปผิดทันที",
              "REST-02 — A hash-chained fiscal journal: altering any past entry breaks the checksum of every entry after it."),
            T("REST-03 — เพดานส่วนลดร้อยละ 50 การให้ส่วนลดเกินกำหนดต้องได้รับอนุมัติจากผู้จัดการกะ",
              "REST-03 — A 50% discount ceiling; anything beyond it requires a shift-manager's approval."),
            T("TIP-01 — การจัดสรรทิปถูกแยกออกจากหน้าที่แคชเชียร์ พนักงานจึงจ่ายทิปให้ตนเองไม่ได้",
              "TIP-01 — Tip distribution is segregated from the cashier duty, so no one can pay tips to themselves."),
            T("REST-11 — บันทึกการเปิดลิ้นชักเงินสดทุกครั้งพร้อมเหตุผล และกระทบยอดกับรายงานปิดกะ",
              "REST-11 — Every cash-drawer opening is logged with a reason and reconciled against the Z-report."),
        ],
        "wow":[
            T("สมุดภาษีที่ตรวจแก้ย้อนหลังไม่ได้ด้วยการเข้ารหัส ไม่ใช่เพียงบันทึกการใช้งาน และการตรวจสอบชี้จุดที่ถูกแก้ไขได้อย่างแม่นยำ",
              "A cryptographically tamper-evident fiscal journal — not merely an activity log — whose verification pinpoints exactly where any change occurred."),
            T("ลูกค้าสั่งและชำระเงินได้ด้วยตนเองอย่างครบวงจร โดยไม่มีความเสี่ยงเรื่องการแก้ไขราคา","Guests order and pay entirely on their own, with no exposure to price tampering."),
            T("ทำงานต่อเนื่องเมื่อขาดการเชื่อมต่อ ทั้งการขายด่วนและการเปิดโต๊ะส่งครัว แล้วส่งข้อมูลกลับระบบกลางเพียงครั้งเดียวอย่างแม่นยำ","Keeps operating offline for both quick sales and dine-in kitchen firing, then replays to the cloud exactly once."),
            T("การแจ้งเตือนการแพ้อาหารปรากฏบนทุกตั๋วครัวแบบเรียลไทม์ และหายไปทันทีเมื่อลูกค้าถอนความยินยอม","Allergen alerts appear on every kitchen ticket in real time and disappear instantly when consent is withdrawn."),
        ],
        "routes":["/pos/register","/kds","/tables","/pos/till","/buffet","/track/{token}"]})

    # 2 — Loyalty
    S.append({"t":"mod_over","accent":"gold","glyph":"◆","tag":T("ผูก LINE","LINE-NATIVE"),
        "family":T("สมาชิกและคะแนนสะสม","Membership & Loyalty"),
        "title":T("ระบบสมาชิกและคะแนนสะสมที่ผูกกับบัญชีแยกประเภทจริง","A loyalty program tied to the general ledger"),
        "positioning":T("ออกแบบให้ปลอดภัยต่อธุรกรรมพร้อมกัน บันทึกบัญชีตามมาตรฐาน TFRS 15 และใช้ LINE Official Account เป็นแกนกลางของการยืนยันตัวตน ครอบคลุมภารกิจ การแนะนำเพื่อน วงล้อของรางวัล ระดับสมาชิก และเครือข่ายพันธมิตร โดยคะแนนสะสมถือเป็นบัญชีย่อยที่กระทบยอดกับภาระผูกพันคะแนนในบัญชี 2250",
                        "It is concurrency-safe, accounts for points under TFRS 15, and puts LINE identity at its core. Missions, referrals, spin-to-win, tiers and a partner coalition all sit on top — and points are a real sub-ledger that reconciles to the loyalty-liability account (2250)."),
        "features":[
            (T("คะแนนและระดับสมาชิก","Points & tiers"),
             T("การสะสมและแลกคะแนนทำงานภายใต้การล็อกระดับฐานข้อมูล จึงไม่มีคะแนนตกหล่นแม้ธุรกรรมเกิดพร้อมกัน พร้อมเลื่อนระดับอัตโนมัติและบันทึกประวัติ","Accrual and redemption run under database locking, so no points are lost under concurrency, with automatic tier promotion and full history.")),
            (T("ของรางวัลและภารกิจ","Rewards & missions"),
             T("แลกเป็นบัตรกำนัล ส่วนลด สินค้า หรือสิทธิพิเศษ พร้อมบัตรสะสมแสตมป์และการแนะนำเพื่อนที่ให้รางวัลเพียงครั้งเดียว","Redeem for vouchers, discounts, products or privileges, with stamp cards and member-get-member referrals rewarded exactly once.")),
            (T("วงล้อของรางวัลที่พิสูจน์ความยุติธรรมได้","Provably-fair spin-to-win"),
             T("สุ่มด้วยการเข้ารหัสฝั่งเซิร์ฟเวอร์ที่ลูกค้าไม่สามารถแทรกแซงได้ พร้อมป้องกันสต๊อกรางวัลติดลบ","A cryptographic server-side draw that guests cannot influence, with atomic prize-stock protection.")),
            (T("แคมเปญและเส้นทางลูกค้า","Campaigns & journeys"),
             T("ส่งข้อความตามกลุ่ม RFM ระดับสมาชิก หรือวันเกิด โดยเคารพความยินยอมและช่วงเวลาที่เหมาะสมทุกครั้ง","Broadcast by RFM segment, tier or birthday, always honouring consent and quiet hours.")),
            (T("เครือข่ายพันธมิตรและแฟรนไชส์","Coalition network"),
             T("สะสมและแลกคะแนนข้ามแบรนด์ในเครือ โดยบันทึกรายการหักกลบระหว่างกิจการที่สมดุลโดยอัตโนมัติตามมูลค่ายุติธรรม","Earn and burn across a franchise, posting a balanced intercompany clearing entry at fair value automatically.")),
            (T("วงจรความพึงพอใจแบบปิด (NPS)","Closed-loop NPS"),
             T("แบบสำรวจหลังการซื้อไม่มีข้อมูลส่วนบุคคลใน URL และเปิดเคสติดตามภายใน 24 ชั่วโมงโดยอัตโนมัติเมื่อพบลูกค้าที่ไม่พึงพอใจ","Post-purchase surveys carry no PII in the URL, and a low score automatically opens a 24-hour service-recovery case.")),
        ]})
    S.append({"t":"mod_ctrl","accent":"gold",
        "family":T("สมาชิกและคะแนนสะสม","Membership & Loyalty"),
        "title":T("คะแนนสะสมคือภาระผูกพันที่บันทึกในบัญชี","Points are a booked liability"),
        "controls":[
            T("MKT-03 — การสะสมและแลกคะแนนปลอดภัยต่อธุรกรรมพร้อมกัน และการตั้งค่ามูลค่าคะแนนแยกจากพนักงานหน้าร้าน",
              "MKT-03 — Accrual and redemption are concurrency-safe, and setting point value is segregated from cashiers."),
            T("MKT-06 — ตั้งสำรองภาระผูกพันคะแนนโดยอัตโนมัติและตัดจำหน่ายคะแนนหมดอายุอย่างเป็นระบบ",
              "MKT-06 — The points liability is accrued automatically and expired points are de-recognised systematically."),
            T("LYL-17 — การให้คะแนนจากใบเสร็จที่ลูกค้าอัปโหลดต้องผ่านผู้ตรวจสอบคนที่สอง และป้องกันการนับซ้ำ",
              "LYL-17 — Points from customer-uploaded receipts require a second reviewer and are protected against duplicates."),
            T("G13 — การโอนคะแนนที่พนักงานทำให้เกิน 500 คะแนน ต้องได้รับอนุมัติจากผู้มีอำนาจคนละคน",
              "G13 — Staff-initiated point transfers above 500 points require approval from a different authoriser."),
        ],
        "wow":[
            T("คะแนนสะสมถูกบันทึกเป็นภาระผูกพันในบัญชี 2250 ตามมาตรฐาน TFRS 15 พร้อมการตั้งสำรองและตัดจำหน่ายอัตโนมัติเมื่อปิดงวด","Points are booked as a liability (account 2250) under TFRS 15, with automatic accrual and breakage at period close."),
            T("เครือข่ายพันธมิตรให้สะสมและแลกได้ทุกสาขา โดยรายการหักกลบระหว่างกิจการบันทึกอย่างสมดุลเสมอ","A coalition lets members earn and burn anywhere, with the intercompany clearing entry always balanced."),
            T("วงล้อของรางวัลสุ่มด้วยการเข้ารหัสที่พิสูจน์ความยุติธรรมได้ และบันทึกทุกครั้งที่หมุน","A cryptographically provably-fair prize wheel, with every spin recorded."),
            T("คะแนนความพึงพอใจที่ต่ำจะกลายเป็นเคสติดตามที่มีกำหนดเวลา ไม่หายไปอย่างเงียบ ๆ","A poor satisfaction score becomes a time-bound recovery case rather than vanishing silently."),
        ],
        "routes":["/loyalty","/loyalty/members/:id","/loyalty/journeys","/loyalty/receipt-approvals","/m"]})

    # 3 — CRM, Pipeline & CPQ
    S.append({"t":"mod_over","accent":"violet","glyph":"◎","tag":None,
        "family":T("ลูกค้าสัมพันธ์ ไปป์ไลน์ และใบเสนอราคา","CRM, Pipeline & CPQ"),
        "title":T("งานขายและบริการหลังการขายบนฐานข้อมูลลูกค้าเดียว","Sales and after-sales on a single customer spine"),
        "positioning":T("รวมกระดานไปป์ไลน์ การจัดการโอกาสการขาย ระบบเสนอราคาที่บังคับอัตรากำไรขั้นต่ำ และงานบริการหลังการขายไว้บนฐานข้อมูลลูกค้าชุดเดียว มุมมองลูกค้า 360 องศาแสดงยอดหนี้ วงเงินเครดิต ดีล ใบเสนอราคา และคะแนนสะสมในหน้าจอเดียว ทีมขายจึงเห็นภาพทางการเงินก่อนทุกการติดต่อ",
                        "A single customer record carries the pipeline board, opportunity management, a margin-enforcing quote engine and the full after-sales workspace. A 360-degree view brings receivables, credit limit, deals, quotes and loyalty together on one screen, so sales sees the financial picture before every conversation."),
        "features":[
            (T("พื้นที่ทำงานลูกค้าสัมพันธ์","CRM workspace"),
             T("กระดานแบบลากวางที่ปรับขั้นตอนได้ตามธุรกิจ พร้อมมุมมองรายการ ตัวกรองที่บันทึกไว้ และไทม์ไลน์กิจกรรมรวมของแต่ละดีล","A drag-and-drop board with configurable stages, list views, saved filters and a unified activity timeline per deal.")),
            (T("บันทึกและจัดการลูกค้ามุ่งหวัง","Lead capture & management"),
             T("นำเข้าจำนวนมากผ่านไฟล์ ฟอร์มรับข้อมูลจากเว็บ และการให้คะแนนที่อธิบายเหตุผลได้ พร้อมศูนย์ติดตามตามระดับบริการ","Bulk import, web-to-lead forms and explainable lead scoring, with a follow-up centre governed by service-level targets.")),
            (T("มุมมองลูกค้า 360 องศา","Customer 360"),
             T("รวมสถานะเครดิต ยอดค้างชำระ ดีลที่เปิดอยู่ ใบเสนอราคา และคะแนนสะสมของลูกค้ารายเดียวกันไว้ในภาพเดียว","Brings credit status, overdue balances, open deals, quotes and loyalty for the same customer into one view.")),
            (T("ใบเสนอราคาที่บังคับอัตรากำไร","Margin-enforced quoting"),
             T("คำนวณราคาฝั่งเซิร์ฟเวอร์ และยอมรับใบเสนอราคาไม่ได้จนกว่าจะผ่านอัตรากำไรขั้นต่ำ ชุดสินค้าก็ไม่สามารถหลบเลี่ยงได้","Prices computed server-side; a quote cannot be accepted until it clears the minimum-margin floor, and bundles cannot slip past it.")),
            (T("บริการหลังการขายและสัญญา","After-sales & contracts"),
             T("สัญญาบริการพร้อมข้อตกลงระดับบริการ การเรียกเก็บแบบสมัครสมาชิก การรับประกัน และการจัดการเคสพร้อมรับอีเมลเข้าเป็นเคสอัตโนมัติ","Service contracts with SLAs, subscription billing, warranty and support cases with automatic email-to-case.")),
            (T("การรับประกันและสิทธิ์","Warranty & entitlement"),
             T("ตรวจสิทธิ์อัตโนมัติเมื่อมีการเคลม หากอยู่ในระยะประกันจะอนุมัติฟรีทันที นอกระยะประกันจะรอผู้อนุมัติอิสระ พร้อมทะเบียนข้อยกเว้นสำหรับการตรวจสอบ","Entitlement is checked automatically at claim time: in-warranty is free instantly, out-of-warranty waits for an independent approver, with an exceptions register for audit.")),
        ]})
    S.append({"t":"mod_ctrl","accent":"violet",
        "family":T("ลูกค้าสัมพันธ์ ไปป์ไลน์ และใบเสนอราคา","CRM, Pipeline & CPQ"),
        "title":T("ขายต่ำกว่าต้นทุนไม่ได้หากไม่มีลายเซ็นที่สอง","No below-margin sale without a second signature"),
        "controls":[
            T("CPQ-01 — ส่วนลดหรืออัตรากำไรที่ต่ำกว่าเกณฑ์จะถูกพักไว้ และยอมรับใบเสนอราคาไม่ได้จนกว่าผู้อนุมัติอิสระจะพิจารณา",
              "CPQ-01 — A discount or margin below policy is held, and the quote cannot be accepted until an independent approver clears it."),
            T("CPQ-03 — การยอมรับใบเสนอราคาที่ก่อให้เกิดรายได้ต้องทำโดยบุคคลอื่นที่ไม่ใช่ผู้จัดทำ",
              "CPQ-03 — Accepting a revenue-bearing quote must be done by someone other than its author."),
            T("SVC-01 — การให้เคลมฟรีนอกเงื่อนไขการรับประกันต้องได้รับอนุมัติจากผู้พิจารณาอิสระ",
              "SVC-01 — Granting a free claim outside warranty coverage requires an independent approver."),
            T("R09 / R10 — ข้อมูลหลักด้านเครดิตและกฎราคาถูกแยกออกจากหน้าที่การขาย",
              "R09 / R10 — Credit master data and pricing rules are segregated from the selling function."),
        ],
        "wow":[
            T("ระบบไม่อนุญาตให้ปิดการขายต่ำกว่าอัตรากำไรขั้นต่ำจนกว่าจะมีผู้อนุมัติอิสระ และชุดสินค้าไม่สามารถแอบให้ส่วนลดรวมได้","A sale below the margin floor is blocked until an independent approver clears it, and bundles cannot conceal a blended discount."),
            T("มุมมองลูกค้า 360 องศารวมความเสี่ยงด้านเครดิต ยอดค้าง ดีล ใบเสนอราคา และระดับสมาชิกไว้ก่อนการติดต่อทุกครั้ง","Customer 360 unites credit risk, arrears, deals, quotes and loyalty tier ahead of every conversation."),
            T("สิทธิ์การรับประกันถูกตรวจสอบอัตโนมัติเมื่อเคลม พร้อมบันทึกทุกการอนุมัติฟรีนอกเงื่อนไขไว้ให้ผู้ตรวจสอบ","Warranty entitlement is verified automatically at claim time, and every free out-of-coverage grant is logged for auditors."),
            T("ตั้งแต่ลูกค้ามุ่งหวังจนถึงบริการหลังการขายอยู่บนฐานข้อมูลลูกค้าเดียว พร้อมประวัติการเปลี่ยนขั้นแบบเพิ่มได้อย่างเดียว","From lead to after-sales, everything sits on one customer record with an append-only stage history."),
        ],
        "routes":["/crm","/crm/deals/{OPP}","/service","/service/warranty","/service/renewals","/cpq"]})

    # 4 — Marketing, Pricing & Promotions
    S.append({"t":"mod_over","accent":"coral","glyph":"◈","tag":None,
        "family":T("การตลาด ราคา และโปรโมชัน","Marketing, Pricing & Promotions"),
        "title":T("ราคาและส่วนลดที่ไม่มีผลบังคับใช้ก่อนผ่านการอนุมัติ","No price or discount goes live unreviewed"),
        "positioning":T("การเปลี่ยนแปลงราคาและกฎส่วนลดทุกครั้งต้องผ่านการอนุมัติจากบุคคลอื่น โดยระบบคำนวณราคาจะอ่านเฉพาะกฎที่อนุมัติแล้วเท่านั้น เสริมด้วยการจัดการแคมเปญและกลุ่มเป้าหมาย การทดสอบ A/B ที่มีนัยสำคัญทางสถิติจริง รายงานผลตอบแทนที่ซื่อสัตย์ต่ออัตรากำไร และการส่งออกกลุ่มเป้าหมายแบบเข้ารหัสตามหลัก PDPA",
                        "Every price and discount-rule change requires a second person's approval, and the pricing engine reads only approved rules. On top sit campaign and segment management, A/B testing with genuine statistical significance, margin-honest ROI reporting, and consent-gated, hash-only audience export under PDPA."),
        "features":[
            (T("แคมเปญและกลุ่มเป้าหมาย","Campaigns & segments"),
             T("แคมเปญที่เปิด-ปิดได้ กลุ่มลูกค้าตามหลัก RFM การกระตุ้นตะกร้าที่ถูกทิ้ง และแบบสำรวจความพึงพอใจ","On/off campaigns, RFM-based segments, abandoned-cart nudges and satisfaction surveys.")),
            (T("โปรโมชันและกฎราคา","Promotions & pricing rules"),
             T("รองรับส่วนลดหลายรูปแบบและกฎราคาที่กำหนดเงื่อนไขตามวัน เวลา และช่องทางได้อย่างละเอียด","A full range of promotion types and pricing rules gated by day, time and channel.")),
            (T("การตลาดผ่าน LINE แบบวงจรปิด","Closed-loop LINE marketing"),
             T("ส่งคูปองเฉพาะบุคคลตามพฤติกรรม แล้ววัดการแลกใช้เพื่อปิดวงจร พร้อมทดสอบ A/B ด้วยกลุ่มควบคุมที่กำหนดแน่นอน","Behaviour-triggered personal coupons measured through to redemption, with deterministic A/B and holdout groups.")),
            (T("การทดสอบ A/B ที่เชื่อถือได้","Trustworthy A/B testing"),
             T("รายงานช่วงความเชื่อมั่นและค่านัยสำคัญจริง พร้อมระบุเมื่อกลุ่มตัวอย่างเล็กเกินกว่าจะสรุปผล","Reports real confidence intervals and p-values, and flags when a sample is too small to conclude.")),
            (T("รายงานผลตอบแทนที่ซื่อสัตย์","Margin-honest ROI"),
             T("นับส่วนลดเป็นต้นทุน ไม่ใช่รายได้ และวัดยอดขายส่วนเพิ่มเทียบกับกลุ่มควบคุม","Treats discount as cost, not revenue, and measures incremental lift against a holdout baseline.")),
            (T("ส่งออกกลุ่มเป้าหมายตาม PDPA","Consent-gated audience export"),
             T("ส่งออกเฉพาะค่าแฮชไปยัง Meta และ Google ภายใต้ความยินยอมที่ยังมีผล และซิงก์การถอนความยินยอมกลับโดยอัตโนมัติ","Exports only hashed values to Meta and Google under live consent, and syncs consent withdrawals back automatically.")),
        ]})
    S.append({"t":"mod_ctrl","accent":"coral",
        "family":T("การตลาด ราคา และโปรโมชัน","Marketing, Pricing & Promotions"),
        "title":T("ส่วนลดไม่มีผลบังคับใช้จนกว่าจะมีผู้อนุมัติ","A discount is inactive until someone approves it"),
        "controls":[
            T("MKT-01 — กฎราคาและโปรโมชันถูกพักไว้จนกว่าบุคคลอื่นจะเปิดใช้งาน และระบบคำนวณราคาอ่านเฉพาะกฎที่อนุมัติแล้ว",
              "MKT-01 — Pricing and promotion rules stay inactive until a different person activates them, and the engine reads only approved rules."),
            T("MKT-02 — จำนวนครั้งการใช้โปรโมชันถูกบังคับอย่างเป็นอะตอม ป้องกันการใช้เกินโควตา",
              "MKT-02 — Promotion usage limits are enforced atomically, preventing over-use."),
            T("REV-20 — การเปิดใช้แคมเปญบัตรกำนัลต้องมีผู้อนุมัติที่สอง และแต่ละรหัสแลกใช้ได้เพียงครั้งเดียว",
              "REV-20 — Voucher-campaign activation requires a second approver, and each code redeems only once."),
            T("PDPA-05 — การส่งออกกลุ่มเป้าหมายทำได้เฉพาะเมื่อมีบันทึกกิจกรรมและความยินยอมที่มีผล และส่งเฉพาะค่าแฮช",
              "PDPA-05 — Audience export requires a recorded processing activity and live consent, and emits hashed values only."),
        ],
        "wow":[
            T("ส่วนลดไม่สามารถมีผลบังคับใช้ได้จนกว่าจะมีผู้อื่นอนุมัติ อัตรากำไรจึงไม่ถูกให้ไปอย่างเงียบ ๆ","A discount cannot take effect until another person approves it, so margin is never given away quietly."),
            T("การทดสอบ A/B ให้ผลที่ไม่บิดเบือน ด้วยช่วงความเชื่อมั่นและค่านัยสำคัญจริง พร้อมเตือนเมื่อตัวอย่างเล็กเกินไป","A/B tests do not mislead: real confidence intervals and p-values, with a warning when the sample is underpowered."),
            T("ส่งกลุ่มเป้าหมายไปยัง Meta และ Google โดยข้อมูลส่วนบุคคลไม่รั่วออก และการถอนความยินยอมจะลบสมาชิกออกจริง","Push audiences to Meta and Google with no PII leaving, and a withdrawal actively removes the member."),
            T("รายงานผลตอบแทนวัดยอดขายส่วนเพิ่มเทียบกลุ่มควบคุม และนับส่วนลดเป็นต้นทุน","ROI measures incremental lift against a holdout and counts discount as a cost."),
        ],
        "routes":["/marketing","/settings/messaging","/crm/audience-export","/reputation","/mmm"]})

    # 5 — Returns & Gift cards (single two-panel)
    S.append({"t":"two_panel","accent":"green",
        "section":T("เจาะลึกแต่ละโมดูล","Module deep dive"),
        "kicker":T("การคืนสินค้า และบัตรกำนัล","Returns & Stored Value"),
        "title":T("การคืนเงินและบัตรกำนัลที่บันทึกสมบูรณ์เป็นหนึ่งเดียว","Refunds and gift cards recorded atomically"),
        "left":(T("การคืนสินค้าและคืนเงิน","Returns & refunds"),"↺","green",[
            (T("บันทึกครบในธุรกรรมเดียว","One atomic transaction"),
             T("การคืนเงิน รับสินค้าเข้าสต๊อก บันทึกการคืน และกลับรายการบัญชี ทำพร้อมกันทั้งหมดหรือไม่ทำเลย","Refund, restock, return record and ledger reversal all commit together, or none of them do.")),
            (T("คืนตามสัดส่วน","Pro-rated refunds"),
             T("คำนวณมูลค่าและภาษีมูลค่าเพิ่มตามจำนวนที่คืนจริง","Value and VAT are computed in proportion to the quantity returned.")),
            (T("ป้องกันการคืนเกิน","Over-return guards"),
             T("ตรวจสอบยอดสะสม จึงคืนเกินจำนวนที่ขายหรือชำระไปไม่ได้","Cumulative checks prevent returning or refunding more than was sold or paid.")),
            (T("แยกอำนาจอนุมัติ","Segregated authority"),
             T("การอนุมัติคืนเงินแยกจากการทำรายการ และซ่อนจากแคชเชียร์ในระดับหน้าจอ","Refund approval is separated from processing and hidden from cashiers at the screen level.")),
        ]),
        "right":(T("บัตรกำนัลและเครดิตร้าน","Gift cards & store credit"),"▤","teal",[
            (T("บัตรกำนัลคือหนี้สิน","Cards are a liability"),
             T("มูลค่าไม่เกิน 5,000 บาทออกใช้ได้ทันที เกินกว่านั้นต้องรอผู้อนุมัติด้านการเงินอิสระ","Up to 5,000 THB issues instantly; above that waits for an independent finance approver.")),
            (T("ป้องกันการใช้ซ้ำ","Double-spend protection"),
             T("การแลกใช้อยู่ภายใต้การล็อกระดับรายการ จึงใช้บัตรซ้ำไม่ได้","Redemption runs under row-level locking, so a card cannot be spent twice.")),
            (T("บัญชีย่อยครบถ้วน","Full sub-ledger"),
             T("บันทึกทุกการออก แลก และเติมมูลค่า พร้อมกระทบยอดกับบัญชี 2200","Records every issue, redemption and top-up, reconciled to account 2200.")),
            (T("เครดิตร้านชั้นหนึ่ง","First-class store credit"),
             T("การคืนเป็นเครดิตร้านสร้างบัตรที่มีมูลค่าจริงพร้อมบัญชีย่อยเต็มรูปแบบ","A refund to store credit mints a real, fully sub-ledgered card.")),
        ])})

    # 6 — Procurement / P2P
    S.append({"t":"mod_over","accent":"teal","glyph":"▣","tag":None,
        "family":T("การจัดซื้อจัดจ้าง","Procurement / Procure-to-Pay"),
        "title":T("วงจรจัดซื้อถึงจ่ายเงินที่แยกหน้าที่ทุกขั้นตอน","A procure-to-pay cycle segregated at every step"),
        "positioning":T("ตั้งแต่คำขอซื้อ ใบสั่งซื้อ การรับสินค้า การจับคู่เอกสารสามทาง จนถึงการจ่ายเงิน แต่ละขั้นตอนอยู่คนละหน้าจอและคนละหน้าที่ ระบบผสานประสบการณ์การสั่งซื้อที่เรียบง่ายเข้ากับการควบคุมแบบผู้ทำและผู้อนุมัติทุกจุดตัดสินใจ เพื่อให้กิจการจ่ายเฉพาะสินค้าที่สั่งอย่างถูกต้อง รับจริง ในราคาที่ตกลง จากผู้ขายที่ได้รับอนุมัติ",
                        "From requisition to purchase order, goods receipt, three-way match and payment, each step lives on its own screen and duty. It pairs a consumer-grade buying experience with maker-and-checker control at every decision, so the business pays only for goods that were properly ordered, actually received, at the agreed price, from an approved vendor."),
        "features":[
            (T("คำขอซื้อและร้านค้าภายใน","Requisitions & internal shop"),
             T("พนักงานร้องขอได้ผ่านแคตตาล็อกที่ค้นหาง่าย พร้อมรายการโปรด รายการประจำที่ซิงก์ข้ามอุปกรณ์ และการสแกนบาร์โค้ด","Anyone can request through a searchable catalogue, with favourites, cross-device saved baskets and barcode scanning.")),
            (T("สั่งซื้อผ่าน LINE","Ordering via LINE"),
             T("สร้าง อนุมัติ และรับของผ่านแชต LINE โดยทุกเส้นทางเรียกใช้ขั้นตอนเดียวกับหน้าเว็บ การแยกหน้าที่จึงบังคับใช้เหมือนกัน","Create, approve and receive through LINE chat; every path runs the same workflow as the web, so segregation of duties holds identically.")),
            (T("ใบสั่งซื้อและการสอบราคา","Purchase orders & RFQ"),
             T("ออกใบขอเสนอราคาและใบสั่งซื้อหลายสกุลเงิน พร้อมทำเครื่องหมายรายการทรัพย์สินเพื่อส่งเข้าทะเบียนสินทรัพย์","Issue RFQs and multi-currency purchase orders, flagging capital lines to route into the fixed-asset register.")),
            (T("การรับสินค้าแบบนับก่อนเห็นยอด","Blind-count receiving"),
             T("ระบบไม่แสดงจำนวนที่สั่งไว้ล่วงหน้า มีการควบคุมการรับเกิน และเปิดช่วงเวลาเคลมพร้อมภาพถ่ายที่หน้างาน","The ordered quantity is never pre-filled, over-receipt is controlled, and a photo-evidenced claim window opens at the dock.")),
            (T("การจับคู่สามทางและอ่านเอกสารด้วย AI","Three-way match & AI intake"),
             T("สแกนใบแจ้งหนี้ให้ระบบดึงข้อมูล จับคู่กับใบสั่งซื้อ บันทึกตั้งหนี้ และตรวจสามทางในขั้นตอนเดียว โดยปฏิเสธเอกสารซ้ำ","Scan an invoice; the system extracts it, matches the purchase order, books the bill and runs the three-way match in one flow, rejecting duplicates.")),
            (T("คะแนนผู้ขายและพอร์ทัลคู่ค้า","Vendor scorecards & portal"),
             T("จัดอันดับผู้ขายตามการส่งตรงเวลา คุณภาพ และส่วนต่างราคา พร้อมพอร์ทัลให้คู่ค้ายืนยันคำสั่งซื้อและส่งใบแจ้งหนี้เอง","Rank vendors by on-time delivery, quality and price variance, with a portal for suppliers to acknowledge orders and submit invoices.")),
        ]})
    S.append({"t":"mod_ctrl","accent":"teal",
        "family":T("การจัดซื้อจัดจ้าง","Procurement / Procure-to-Pay"),
        "title":T("ปิดช่องทุจริตในทุกจุดตัดสินใจของการจ่ายเงิน","Closing fraud gaps at every payment decision"),
        "controls":[
            T("R03 / R04 / R07 — ผู้ซื้อ ผู้รับของ และผู้อนุมัติเป็นคนละบุคคล และการรับของต้องใช้สิทธิ์เฉพาะ",
              "R03 / R04 / R07 — Buyer, receiver and approver are different people, and receiving requires its own dedicated permission."),
            T("EXP-06 — การจ่ายเจ้าหนี้ต้องมีผู้ขอและผู้อนุมัติคนละคน โดยบังคับใช้แม้กับผู้ดูแลระบบ",
              "EXP-06 — Vendor payment requires a distinct requester and approver, enforced even against the administrator."),
            T("EXP-11 — การเปลี่ยนบัญชีธนาคารของผู้ขายต้องผ่านการอนุมัติที่สองและเข้ารหัสจัดเก็บ เพื่อป้องกันการฉ้อโกงทางอีเมล",
              "EXP-11 — Changing a vendor's bank account requires second approval and is encrypted at rest, defending against business-email fraud."),
            T("EXP-13 — รอบการจ่ายเงินแยกผู้เสนอ ผู้อนุมัติ และผู้สั่งจ่าย และไฟล์โอนธนาคารผูกกับรอบที่อนุมัติด้วยลายเซ็นดิจิทัล",
              "EXP-13 — A payment run separates proposer, approver and executor, and the bank file is cryptographically pinned to the approved run."),
        ],
        "wow":[
            T("สั่งซื้อผ่าน LINE ได้โดยการควบคุมไม่สูญหาย ทุกเส้นทางเรียกใช้ขั้นตอนเดียวกับหน้าเว็บ","Order through LINE with the controls intact — every path runs the same workflow as the web."),
            T("การอ่านเอกสารด้วย AI ดึงข้อมูล จับคู่ใบสั่งซื้อ ตั้งหนี้ และตรวจสามทางให้เอง พร้อมปฏิเสธใบแจ้งหนี้ซ้ำ","AI intake extracts, matches, books and three-way-checks the bill on its own, and refuses duplicate invoices."),
            T("การรับสินค้าแบบนับก่อนเห็นยอดช่วยลดการยืนยันโดยไม่นับจริง พร้อมช่วงเวลาเคลมและภาพหลักฐานที่หน้างาน","Blind-count receiving deters confirming without counting, with a claim window and dock-photo evidence."),
            T("การป้องกันการฉ้อโกงทางอีเมลอยู่ในระบบตั้งแต่ต้น ทั้งการล็อกบัญชีผู้รับเงินและการผูกไฟล์จ่ายกับรอบที่อนุมัติ","Business-email-fraud defence is built in — payee accounts are locked and the payment file is bound to the approved run."),
        ],
        "routes":["/requisitions","/shop","/receiving","/procurement/match","/procurement/ap-intake","/disbursements"]})

    # 7 — Inventory & WMS
    S.append({"t":"mod_over","accent":"cyan","glyph":"▦","tag":None,
        "family":T("คลังสินค้าและต้นทุน","Inventory, Warehouse & Costing"),
        "title":T("สินค้าคงคลังแบบต่อเนื่องที่มีมูลค่าและกระทบยอดกับบัญชีทุกงวด","A perpetual, valued inventory that ties to the ledger every period"),
        "positioning":T("บัญชีย่อยสินค้าคงคลังแบบต่อเนื่องที่รับประกันว่าสต๊อกครบถ้วน ขายเกินไม่ได้ คิดต้นทุนถูกต้องเมื่อมีการเบิกใช้ และกระทบยอดกับบัญชีคุมสินค้าคงคลังทุกงวด ครอบคลุมทั้งการบริหารคลังสมัยใหม่และเครื่องยนต์คำนวณต้นทุน พร้อมการควบคุมแบบผู้ทำและผู้อนุมัติในทุกการเคลื่อนไหวที่กระทบมูลค่า",
                        "A perpetual, valued sub-ledger that keeps stock complete, prevents overselling, costs consumption correctly and reconciles to the inventory control account every period. It spans a modern warehouse operation and a full costing engine, with maker-and-checker control over every value-affecting move."),
        "features":[
            (T("บัญชีสต๊อกแบบต่อเนื่องมีมูลค่า","Perpetual valued ledger"),
             T("ทุกการรับ เบิก และปรับปรุงบันทึกเป็นรายการบัญชีที่สมดุลและไม่ซ้ำ พร้อมแถบกระทบยอดกับบัญชีคุมสินค้า","Every receipt, issue and adjustment posts a balanced, idempotent entry, with a reconciliation banner against the control account.")),
            (T("วิธีคิดต้นทุนที่ยืดหยุ่น","Flexible costing methods"),
             T("เลือกต้นทุนถัวเฉลี่ยเคลื่อนที่ หรือชั้นต้นทุนแบบเข้าก่อนออกก่อน และหมดอายุก่อนออกก่อนสำหรับสินค้าที่มีวันหมดอายุ","Choose moving-average, or FIFO / FEFO cost layers for perishables with expiry.")),
            (T("การกระจายต้นทุนนำเข้า","Landed-cost allocation"),
             T("นำค่าขนส่ง อากร และประกันเข้ารวมในต้นทุนต่อหน่วยตามฐานที่เลือก และปรับปรุงมาตรฐานต้นทุนแบบผู้ทำและผู้อนุมัติ","Capitalise freight, duty and insurance into unit cost, with maker-checker standard-cost revisions.")),
            (T("การนับสต๊อกตามความเสี่ยง","Risk-based cycle counting"),
             T("แยกหน้าที่ผู้นับออกจากผู้ปรับปรุง จัดกลุ่มสินค้าตามมูลค่า และนับแบบไม่เห็นยอดในระบบ","The counter is separated from the poster, items are ranked by value, and counts are blind to the book quantity.")),
            (T("การโอนย้ายและใบสั่งโอน","Transfers & transfer orders"),
             T("โอนระหว่างคลังสองขั้นตอนผ่านบัญชีสินค้าระหว่างทาง โดยผู้ส่งและผู้รับเป็นคนละคน พร้อมรายงานอายุสินค้าระหว่างทาง","Two-step inter-warehouse transfers through a goods-in-transit account, with a different shipper and receiver, and in-transit aging.")),
            (T("คลัง 3 มิติและการเรียกคืนล็อต","3D warehouse & lot recall"),
             T("แสดงผังคลังสามมิติตามอัตราการใช้พื้นที่ ป้องกันการบรรจุเกิน และเรียกคืนล็อตได้สองทางพร้อมกักกันออกจากการหยิบและการขาย","A 3D warehouse coloured by utilisation, over-fill protection, and two-way lot recall with quarantine from picking and sale.")),
        ]})
    S.append({"t":"mod_ctrl","accent":"cyan",
        "family":T("คลังสินค้าและต้นทุน","Inventory, Warehouse & Costing"),
        "title":T("มูลค่าสินค้าที่พิสูจน์ความถูกต้องได้ด้วยตัวเอง","Inventory value that proves itself"),
        "controls":[
            T("R11 — ผู้ปรับปรุงยอดสต๊อกกับผู้นับต้องเป็นคนละคน โดยแยกเป็นคนละหน้าจอ",
              "R11 — The person who adjusts stock and the person who counts it are different, on separate screens."),
            T("INV-01 — ไม่มีการขายเกินสต๊อก ด้วยการล็อกระดับรายการเมื่อหยิบและตัดจ่าย",
              "INV-01 — No overselling, enforced by row-level locking at pick and issue."),
            T("INV-07 — การตัดจำหน่ายสต๊อกต้องมีผู้อนุมัติที่สอง โดยบังคับใช้แม้กับผู้ดูแลระบบ",
              "INV-07 — Write-offs require a second approver, enforced even against the administrator."),
            T("COST-01 / COST-02 — ผู้จัดเตรียมต้นทุนกับผู้บันทึกต้องเป็นคนละคน",
              "COST-01 / COST-02 — The preparer of a cost change and the person who posts it are different."),
        ],
        "wow":[
            T("ผังคลังสามมิติหมุนดูได้ ระบายสีตามความจุ และเน้นตำแหน่งสินค้าที่ค้นหา พร้อมการป้องกันการบรรจุเกิน","A 3D warehouse you can orbit, coloured by capacity, that highlights where an item sits — with hard over-fill protection."),
            T("ทุกการเคลื่อนไหวบันทึกเป็นรายการบัญชีที่สมดุลและไม่ซ้ำ และกระทบยอดกับบัญชีคุมสินค้า มูลค่าสต๊อกจึงตรวจสอบได้เสมอ","Every move posts a balanced, idempotent entry and reconciles to the control account, so the value always ties out."),
            T("การนับตามความเสี่ยงจัดลำดับสินค้าตามมูลค่า และนับแบบไม่เห็นยอด การขาดหายจึงปิดบังได้ยาก","Risk-based counting ranks items by value and hides the book figure, making shrinkage hard to conceal."),
            T("เรียกคืนล็อตได้ในคลิกเดียว ด้วยการสืบย้อนสองทางและการกักกันที่ตัดล็อตออกจากการหยิบและการขายจริง","Recall a lot in one click, with two-way genealogy and a hold that removes it from picking and sale."),
        ],
        "routes":["/inventory","/inventory-ledger","/wms","/lots","/stock-ops/cycle-counts","/costing/landed-cost"]})

    # 8 — Manufacturing
    S.append({"t":"mod_over","accent":"violet","glyph":"⬡","tag":None,
        "family":T("การผลิต","Manufacturing"),
        "title":T("จากสูตรการผลิตถึงสินค้าสำเร็จรูป พร้อมการจัดตารางแบบจำกัดกำลังการผลิต","From bill of materials to finished goods, with finite-capacity scheduling"),
        "positioning":T("เครื่องยนต์คำนวณต้นทุนที่ทำให้งานระหว่างทำ สินค้าสำเร็จรูป และต้นทุนขายถูกต้อง ครบถ้วน และตัดงวดอย่างเหมาะสม โดยทุกการบันทึกลงบัญชีเป็นรายการที่สมดุลและไม่ซ้ำ เสริมด้วยการวางแผนความต้องการวัสดุหลายระดับ การตรวจสอบกำลังการผลิต และการจัดตารางแบบจำกัดกำลังการผลิต บนพื้นฐานการกำกับสูตรการผลิตแบบผู้ทำและผู้อนุมัติ",
                        "A costing engine that keeps work-in-process, finished goods and cost of sales valid, complete and properly cut off, with every posting balanced and idempotent. On top sit multi-level material planning, capacity checking and finite-capacity scheduling, over a maker-and-checker bill-of-materials governance."),
        "features":[
            (T("สูตรการผลิตและคำสั่งผลิต","BOM & work orders"),
             T("กำหนดและกระจายสูตรการผลิตแบบผู้ทำและผู้อนุมัติ พร้อมวงจรคำสั่งผลิตที่มีการควบคุมสถานะ","Define and distribute bills of materials with maker-checker approval, and run a status-controlled work-order lifecycle.")),
            (T("การเบิกวัสดุและผลต่างต้นทุน","Material issue & variances"),
             T("เบิกวัสดุเข้างานระหว่างทำและปิดงานพร้อมรับรู้ผลต่างผลได้ ต้นทุนที่ผิดปกติจึงไม่ถูกซ่อนในราคาสินค้าสำเร็จรูป","Issue materials into work-in-process and close with yield variance recognised, so anomalies are not hidden in finished-goods cost.")),
            (T("การวางแผนความต้องการวัสดุ","Material requirements planning"),
             T("แตกสูตรการผลิตหลายระดับ หักลบสต๊อกคงเหลือ และรวมความต้องการซื้อเป็นคำขอซื้อ โดยแยกการวางแผนออกจากการจัดซื้อ","Explode multi-level bills, net against on-hand stock and consolidate buys into a requisition, keeping planning separate from purchasing.")),
            (T("การจัดตารางแบบจำกัดกำลังการผลิต","Finite-capacity scheduling"),
             T("จัดลำดับงานลงศูนย์การผลิตตามลำดับก่อนหลังและกำลังการผลิตต่อวัน แล้วให้เวลาเริ่ม-เสร็จ คิวงาน และการแจ้งเตือนงานล่าช้า","Sequence operations onto work centres by precedence and daily capacity, producing start-finish times, dispatch queues and late-job alerts.")),
            (T("การกำหนดวิธีและมูลค่าต้นทุน","Costing configuration"),
             T("กำหนดวิธีคิดต้นทุนต่อกิจการและสินค้า และตีมูลค่าที่กระทบยอดกับบัญชีคุมสินค้าคงคลัง","Set the costing method per company and item, and value inventory in a way that reconciles to the control accounts.")),
            (T("การวิเคราะห์แบบเรียลไทม์","Real-time analytics"),
             T("ส่งตัวชี้วัดการผลิตแบบสตรีมมิงไปยังแดชบอร์ดที่อัปเดตทันที","Stream production metrics to a dashboard that updates in real time.")),
        ]})
    S.append({"t":"mod_ctrl","accent":"violet",
        "family":T("การผลิต","Manufacturing"),
        "title":T("ต้นทุนการผลิตที่ซื่อสัตย์ต่อผลต่าง","Manufacturing cost that is honest about variance"),
        "controls":[
            T("MFG-02 — การเบิกและปิดคำสั่งผลิตบันทึกเป็นรายการที่สมดุลและไม่ซ้ำ พร้อมรับรู้ผลต่างผลได้และผลต่างการใช้วัสดุ",
              "MFG-02 — Work-order issue and completion post balanced, idempotent entries with yield and material-usage variances recognised."),
            T("MFG-01 — สูตรการผลิตกำกับจากส่วนกลางและอนุมัติแบบผู้ทำและผู้อนุมัติ",
              "MFG-01 — Bills of materials are centrally governed and approved through maker-checker."),
            T("R04 / R13 — ผู้สร้างคำสั่งผลิตแยกจากผู้รับของ และการดูแลสูตรการผลิตแยกจากการทำรายการ",
              "R04 / R13 — The work-order creator is separated from the receiver, and BOM maintenance from transacting."),
            T("COST-02 — การปรับมาตรฐานต้นทุนต้องมีผู้จัดเตรียมและผู้อนุมัติคนละคน",
              "COST-02 — A standard-cost revision requires a distinct preparer and approver."),
        ],
        "wow":[
            T("การจัดตารางแบบจำกัดกำลังการผลิตให้ตารางจริงต่อขั้นตอน ทั้งเวลาเริ่ม-เสร็จ คิวงาน และการแจ้งเตือนงานล่าช้า","Finite-capacity scheduling produces a real per-operation schedule with start-finish times, dispatch queues and late-job alerts."),
            T("การปิดงานที่ซื่อสัตย์ต่อผลต่าง ผลได้ที่ขาดจะถูกบันทึกแยก ไม่รวมเข้าราคาสินค้าสำเร็จรูป","Honest completion: short yield is booked separately, never capitalised into finished-goods cost."),
            T("การวางแผนวัสดุที่กลายเป็นคำขอซื้อจริง โดยการวางแผนยังคงแยกจากการจัดซื้อ","Material planning becomes a real requisition, while planning stays segregated from purchasing."),
            T("ทุกการบันทึกทางบัญชีสมดุลและไม่ซ้ำ การทำรายการเดิมซ้ำจึงไม่สร้างผลกระทบซ้อน","Every posting is balanced and idempotent, so repeating an action has no double effect."),
        ],
        "routes":["/manufacturing","/production","/production/schedule","/costing","/bom"]})

    # 9 — Quality
    S.append({"t":"mod_over","accent":"coral","glyph":"◇","tag":None,
        "family":T("การจัดการคุณภาพ","Quality Management"),
        "title":T("ไม่มีผู้ตรวจสอบคนใดปิดงานคุณภาพด้วยลายเซ็นของตนเอง","No inspector closes a quality case on their own signature"),
        "positioning":T("ระบบคุณภาพครบวงจรที่ปิดช่องว่างสำคัญของวงจรคุณภาพ ไม่มีผู้ตรวจสอบคนใดสามารถตัดจำหน่ายสต๊อก ปล่อยสินค้าที่ไม่ได้มาตรฐาน รับรองผู้ขายใหม่ หรือปิดการแก้ไขด้วยลายเซ็นของตนเอง งานรายงานข้อบกพร่อง การแก้ไขเชิงป้องกัน คำขอแก้ไขจากผู้ขาย และใบรับรองผลวิเคราะห์ ต่างต้องมีผู้อนุมัติที่สองอย่างอิสระ",
                        "An end-to-end quality system that closes the largest control gap in the quality cycle: no inspector can scrap stock, release out-of-spec goods, requalify a supplier or close a corrective action on their own signature. Non-conformance, corrective action, supplier corrective action and certificates of analysis each require an independent second approver."),
        "features":[
            (T("ทะเบียนข้อบกพร่อง (NCR)","Non-conformance register"),
             T("บันทึกและจัดการข้อบกพร่องตลอดวงจร โดยการตัดจำหน่ายที่กระทบการเงินต้องรอการอนุมัติ","Record and manage non-conformances through their lifecycle, with financially-material dispositions held for approval.")),
            (T("การแก้ไขและป้องกัน (CAPA)","Corrective & preventive action"),
             T("จัดการวงจรการแก้ไขพร้อมรายการดำเนินการ และการยืนยันประสิทธิผลที่จะเปิดเคสใหม่หากยังไม่ได้ผล","Manage the corrective loop with action items and an effectiveness sign-off that reopens the case if it did not work.")),
            (T("คำขอแก้ไขจากผู้ขาย (SCAR)","Supplier corrective action"),
             T("ดำเนินคำขอแก้ไขจากผู้ขายตามรูปแบบมาตรฐาน โดยผลการยืนยันประสิทธิผลเป็นตัวกำหนดการรับรองผู้ขายใหม่","Run supplier corrective-action requests in a standard format, where the effectiveness verdict governs requalification.")),
            (T("ใบรับรองผลวิเคราะห์","Certificate of analysis"),
             T("กำหนดคุณลักษณะคุณภาพต่อสินค้า ประเมินผ่าน-ไม่ผ่าน และปล่อยสินค้านอกเกณฑ์ผ่านทะเบียนข้อยกเว้น","Define quality specs per item, evaluate pass/fail, and release out-of-spec goods through a deviation register.")),
            (T("การตัดสินและตัดจำหน่าย","Disposition & scrap"),
             T("ตัดสินรับ ซ่อม กักกัน หรือทำลาย และเขียนมูลค่าที่เสียหายเข้าบัญชีขาดทุน","Decide accept, rework, quarantine or scrap, and write the lost value to a loss account.")),
            (T("การบันทึกของเสียหน้างาน","Waste capture"),
             T("บันทึกของเสียตามเหตุผลและการจัดการ พร้อมเทียบการใช้จริงกับมาตรฐาน","Capture waste by reason and disposition, comparing actual against theoretical usage.")),
        ]})
    S.append({"t":"mod_ctrl","accent":"coral",
        "family":T("การจัดการคุณภาพ","Quality Management"),
        "title":T("ทุกการตัดสินต้องมีลายเซ็นที่สอง","Every disposition needs a second signature"),
        "controls":[
            T("QC-01 — การตัดจำหน่ายข้อบกพร่องต้องทำโดยผู้อื่นที่ไม่ใช่ผู้รายงาน โดยบังคับใช้แม้กับผู้ดูแลระบบ",
              "QC-01 — Disposing of a non-conformance must be done by someone other than the person who raised it, enforced even against the administrator."),
            T("QC-02 — การปิดการแก้ไขต้องมีผู้ยืนยันประสิทธิผลอิสระ และหากไม่ได้ผลจะเปิดเคสใหม่",
              "QC-02 — Closing a corrective action requires an independent effectiveness verifier, and an ineffective result reopens the case."),
            T("QC-03 — การปล่อยสินค้านอกเกณฑ์ต้องมีผู้บันทึกและผู้อนุมัติคนละคนพร้อมเหตุผล",
              "QC-03 — Releasing out-of-spec goods requires a distinct recorder and approver, with a reason."),
            T("QC-04 — การปิดคำขอแก้ไขจากผู้ขายต้องทำโดยผู้อื่นที่ไม่ใช่ผู้รายงาน และมีเอกสารครบถ้วน",
              "QC-04 — Closing a supplier corrective action must be done by someone other than the raiser, with complete documentation."),
        ],
        "wow":[
            T("การตัดจำหน่ายสต๊อกลงลายเซ็นตนเองไม่ได้ ทุกการตัดสินทางการเงินจะถูกพักไว้จนกว่าผู้อื่นจะอนุมัติ พร้อมแสดงเลขที่รายการบัญชี","Scrap cannot be self-signed; every financial disposition is held until another person approves, and the journal number is shown."),
            T("การแก้ไขต้องยืนยันประสิทธิผลโดยผู้อิสระ และหากไม่ได้ผลจะเปิดเคสใหม่ ไม่ปิดทั้งที่ปัญหายังอยู่","A corrective action is verified by an independent party, and an ineffective result reopens it rather than closing over a live problem."),
            T("คำขอแก้ไขจากผู้ขายผูกกับการรับรองผู้ขายใหม่ ปิดได้เฉพาะเมื่อเอกสารครบและผลเป็นที่น่าพอใจ","Supplier corrective action is tied to requalification, closing only when the documentation is complete and the result satisfactory."),
            T("ทะเบียนข้อยกเว้นของใบรับรองผลวิเคราะห์คือกลุ่มตัวอย่างที่พร้อมให้ผู้ตรวจสอบพิจารณา","The certificate-of-analysis deviation register is exactly the population an auditor tests."),
        ],
        "routes":["/quality/ncr","/quality/capa","/quality/scar","/quality/coa"]})

    # 10 — Master Data (single card grid)
    S.append({"t":"cards","accent":"teal","cols":3,
        "section":T("เจาะลึกแต่ละโมดูล","Module deep dive"),
        "kicker":T("การจัดการข้อมูลหลัก","Master Data Management"),
        "title":T("เครื่องยนต์เดียวกำกับข้อมูลหลักทุกประเภทและป้องกันการทุจริต","One engine governs all master data and guards against fraud"),
        "intro":T("นำเข้า-ส่งออก ตรวจสอบรายแถว และการอนุมัติที่สองสำหรับข้อมูลอ่อนไหว ทำงานเหมือนกันกับผู้ขาย สินค้า ราคา และรายการส่งเสริมการขาย",
                  "Import, export, per-row validation and second approval for sensitive fields work identically across vendors, items, prices and promotions."),
        "cards":[
            (T("นำเข้าและส่งออกในเครื่องยนต์เดียว","One import-export engine"),
             T("ส่งออก แก้ไขในสเปรดชีต ตรวจสอบแบบทดลอง แล้วยืนยัน โดยรายงานข้อผิดพลาดรายแถวทั้งภาษาไทยและอังกฤษ","Export, edit in a spreadsheet, dry-run validate, then commit, with per-row errors in Thai and English."),"teal"),
            (T("ข้อมูลอ่อนไหวต้องสองลายเซ็น","Two-signature sensitive fields"),
             T("วงเงินเครดิต เงื่อนไขการชำระ ราคา และส่วนลด ถูกพักไว้และปล่อยโดยผู้อนุมัติอิสระเท่านั้น","Credit limits, payment terms, prices and discounts are held and released only by an independent approver."),"coral"),
            (T("การตรวจจับและรวมข้อมูลซ้ำ","Duplicate detection & merge"),
             T("ตรวจจับข้อมูลซ้ำและรวมระเบียนโดยชี้ระเบียนลูกใหม่ คงข้อมูลที่ครบกว่า และเลิกใช้ระเบียนซ้ำโดยไม่ลบ","Detect duplicates and merge records, repointing children, retaining the fuller data and retiring the loser without deletion."),"violet"),
            (T("ประวัติการแก้ไขที่แก้ไม่ได้","Immutable change history"),
             T("บันทึกทุกการเปลี่ยนแปลงที่ระดับฐานข้อมูลแบบเพิ่มได้อย่างเดียว และปิดบังข้อมูลอ่อนไหว","Capture every change at the database layer, append-only, with sensitive fields masked."),"cyan"),
            (T("ฟิลด์กำหนดเองแบบไม่ต้องเขียนโค้ด","No-code custom fields"),
             T("เพิ่มฟิลด์ที่มีชนิดข้อมูลชัดเจนบนทุกรายการโดยไม่ต้องเขียนโค้ด พร้อมตรวจสอบฝั่งเซิร์ฟเวอร์","Add typed fields to any entity without code, validated server-side."),"gold"),
            (T("หน้าตั้งค่าเฉพาะทาง","Focused setup surfaces"),
             T("จัดการหมวดสินค้าและรหัสภาษีผ่านเครื่องยนต์เดียวกัน โดยจำกัดสิทธิ์ให้แคบตามหน้าที่","Manage item categories and tax codes through the same engine, scoped to narrow permissions."),"green"),
        ]})

    # 11 — Finance AR/AP
    S.append({"t":"mod_over","accent":"teal","glyph":"₿","tag":None,
        "family":T("การเงิน ลูกหนี้และเจ้าหนี้","Finance — Receivables & Payables"),
        "title":T("ศูนย์กลางเงินทุนหมุนเวียนที่รวมลูกหนี้และเจ้าหนี้ไว้ในที่เดียว","A working-capital hub for receivables and payables"),
        "positioning":T("รวมวงจรลูกหนี้และเจ้าหนี้ไว้บนหน้าจอเดียว พร้อมใบแสดงยอด การตัดชำระข้ามใบแจ้งหนี้ วงจรอนุมัติจ่ายแบบผู้ทำและผู้อนุมัติ การควบคุมเครดิต เงินทดรอง และการทวงหนี้อัตโนมัติ ทุกจุดที่สัมผัสเงินสดถูกแยกหน้าที่และบันทึกลงบัญชีแยกประเภทโดยอัตโนมัติ",
                        "It unites the receivables and payables cycles on one screen, with statements, cross-invoice settlement, a maker-checker disbursement flow, credit control, advances and automated collections. Every point that touches cash is segregated and posts to the ledger automatically."),
        "features":[
            (T("ใบแสดงยอดลูกหนี้และเจ้าหนี้","Customer & vendor statements"),
             T("แสดงยอดยกมา รายการเคลื่อนไหว และยอดคงเหลือสะสมหลายสกุลเงิน พร้อมส่งออกและแนบไฟล์","Show opening balance, movements and running balance in multiple currencies, with export and attachment.")),
            (T("การตัดชำระข้ามใบแจ้งหนี้","Cross-invoice cash application"),
             T("ชำระเงินครั้งเดียวตัดหลายใบแจ้งหนี้ โดยเศษพักเป็นเงินรับรอตัดชำระ และรายการใหญ่ต้องได้รับอนุมัติที่สอง","Apply one payment across several invoices, parking the remainder on account, with large batches requiring second approval.")),
            (T("การจ่ายเจ้าหนี้แยกทีม","Segregated disbursement"),
             T("ฝ่ายบัญชีขอจ่ายบนหน้าจอหนึ่ง ฝ่ายการเงินอนุมัติและปล่อยเงินบนอีกหน้าจอหนึ่ง","Accounting requests payment on one screen; finance approves and releases the cash on another.")),
            (T("รอบการจ่ายและไฟล์ธนาคารไทย","Payment runs & Thai bank files"),
             T("จ่ายหลายเจ้าหนี้พร้อมกัน พร้อมสร้างไฟล์โอนของธนาคารไทยและมาตรฐานสากล ที่ผูกด้วยลายเซ็นดิจิทัล","Pay many vendors at once, generating Thai and international bank files cryptographically pinned to the approved run.")),
            (T("การควบคุมเครดิต","Credit control"),
             T("การเปลี่ยนวงเงินและการปลดระงับต้องมีผู้อนุมัติที่สอง และการระงับมีผลถึงหน้าร้านและพอร์ทัลลูกค้า","Limit changes and hold releases require a second approver, and holds reach the point of sale and customer portal.")),
            (T("เงินทดรองและเงินสดย่อย","Advances & petty cash"),
             T("บริหารเงินทดรองและกองทุนเงินสดย่อยแบบวงเงินคงที่ พร้อมส่วนลดการจ่ายก่อนกำหนด","Manage advances and imprest petty-cash funds, with early-payment discounts.")),
        ]})
    S.append({"t":"mod_ctrl","accent":"teal",
        "family":T("การเงิน ลูกหนี้และเจ้าหนี้","Finance — Receivables & Payables"),
        "title":T("แยกทีมจริงสองหน้าจอ ผู้ขอจ่ายไม่ใช่ผู้ปล่อยเงิน","Truly separate teams: the requester is not the releaser"),
        "controls":[
            T("EXP-06 — การจ่ายเจ้าหนี้ต้องมีผู้ขอและผู้อนุมัติคนละคน โดยบังคับใช้แม้กับผู้ดูแลระบบ",
              "EXP-06 — Vendor payment requires a distinct requester and approver, enforced even against the administrator."),
            T("REV-08 — การเปลี่ยนวงเงินเครดิตและการปลดระงับต้องมีผู้อนุมัติคนที่สอง",
              "REV-08 — Changing a credit limit or releasing a hold requires a second approver."),
            T("REV-12 — ลูกค้าที่เกินวงเงินหรือค้างชำระเกินกำหนดจะถูกระงับ โดยมีผลถึงหน้าร้านและพอร์ทัล",
              "REV-12 — Customers over their limit or seriously overdue are placed on hold, reaching the point of sale and the portal."),
            T("REC-02 — การกระทบยอดธนาคารต้องมีผู้จัดเตรียมและผู้รับรองคนละคน",
              "REC-02 — Bank reconciliation requires a distinct preparer and certifier."),
        ],
        "wow":[
            T("แยกทีมจริงสองหน้าจอ ฝ่ายบัญชีขอจ่าย ฝ่ายการเงินปล่อยเงิน จึงไม่มีใครทั้งบันทึกและจ่ายในคนเดียว","Two genuinely separate screens: accounting requests, finance releases, so no one both records and pays."),
            T("ไฟล์โอนธนาคารไทยพร้อมใช้งาน พร้อมลายเซ็นดิจิทัลที่พิสูจน์ได้ว่าไฟล์ที่ส่งคือไฟล์ที่อนุมัติ","Ready-to-use Thai bank files, cryptographically pinned to prove the file sent is the file approved."),
            T("การระงับเครดิตมีผลถึงหน้าร้านและพอร์ทัลลูกค้า ด้วยเกณฑ์เดียวกับการทวงหนี้","Credit holds reach the point of sale and customer portal, on the same threshold as collections."),
            T("ใบแสดงยอดหลายสกุลเงินเก็บอัตราแลกเปลี่ยนที่บันทึกไว้ต่อเอกสาร","Multi-currency statements retain the booked exchange rate per document."),
        ],
        "routes":["/finance","/finance/customers","/disbursements","/finance/credit-hold","/advances"]})

    # 12 — General Ledger & Close
    S.append({"t":"mod_over","accent":"gold","glyph":"≣","tag":None,
        "family":T("บัญชีแยกประเภทและการปิดงวด","General Ledger & Close"),
        "title":T("บัญชีที่สมดุลโดยโครงสร้าง พร้อมห้องควบคุมการปิดงวด","A ledger balanced by construction, with a close cockpit"),
        "positioning":T("แกนบัญชีคู่ที่สมดุลโดยโครงสร้าง มีการควบคุมแบบผู้ทำและผู้อนุมัติที่บังคับใช้แม้กับผู้ดูแลระบบ ปิดงวดผ่านห้องควบคุมที่แสดงสถานะความพร้อม พร้อมการวิเคราะห์ความผันแปรและรายการตรวจสอบการเปิดเผยข้อมูล ออกแบบให้ผ่านการตรวจสอบการควบคุมภายในโดยตรง",
                        "A double-entry core that is balanced by construction, with maker-and-checker control enforced even against the administrator. Period close runs through a readiness cockpit, with variance analysis and a disclosure checklist, designed to pass internal-control review directly."),
        "features":[
            (T("รายการบัญชีที่ควบคุม","Controlled journal entries"),
             T("รายการที่บันทึกด้วยมือจะเป็นฉบับร่างและไม่รวมในยอดจนกว่าจะได้รับอนุมัติจากผู้อื่น ทุกรายการสมดุลและไม่ซ้ำ","Manual entries post as drafts, excluded from balances until another person approves; every entry is balanced and idempotent.")),
            (T("งบการเงินและงบกระแสเงินสด","Statements & cash flow"),
             T("จัดทำงบทดลอง งบกำไรขาดทุน งบแสดงฐานะการเงิน และงบกระแสเงินสดที่กระทบยอดกับเงินสดจริงโดยโครงสร้าง","Produce the trial balance, income statement, balance sheet and a cash-flow statement that ties to actual cash by construction.")),
            (T("รายการประจำและค่าใช้จ่ายจ่ายล่วงหน้า","Recurring & prepaid"),
             T("ตั้งรายการประจำและตัดจ่ายค่าใช้จ่ายจ่ายล่วงหน้าแบบอัตโนมัติ โดยผ่านการอนุมัติแบบผู้ทำและผู้อนุมัติ","Schedule recurring entries and amortise prepaid costs automatically, through maker-checker approval.")),
            (T("ผังบัญชีที่กำกับด้วยรหัส","Governed chart of accounts"),
             T("ผังบัญชีกลางที่ใช้ร่วมกัน พร้อมชั้นปรับแต่งต่อกิจการ และการปกป้องบัญชีคุมไม่ให้บันทึกโดยตรง","A shared canonical chart with a per-company overlay, protecting control accounts from direct posting.")),
            (T("กฎการบันทึกบัญชีและการแทนที่","Posting rules & overrides"),
             T("กำหนดกฎการบันทึกได้อย่างละเอียด โดยการแทนที่ต้องได้รับอนุมัติ และบัญชีสำคัญถูกล็อกไว้","Configure posting rules in detail, with overrides requiring approval and key accounts locked.")),
            (T("การปิดงวดและสิ้นปี","Period & year-end close"),
             T("ปิดงวดหลังการกระทบยอดได้รับการรับรอง และปิดสิ้นปีเข้าสู่กำไรสะสมโดยอัตโนมัติ","Close periods after reconciliations are certified, and roll year-end into retained earnings automatically.")),
        ]})
    S.append({"t":"mod_ctrl","accent":"gold",
        "family":T("บัญชีแยกประเภทและการปิดงวด","General Ledger & Close"),
        "title":T("หลักฐานการควบคุมภายในที่พร้อมสำหรับการตรวจสอบ","Internal-control evidence ready for audit"),
        "controls":[
            T("GL-05 — รายการบันทึกด้วยมือต้องมีผู้จัดทำและผู้อนุมัติคนละคน รวมถึงยอดยกมาตอนเริ่มระบบ",
              "GL-05 — Manual entries require a distinct preparer and approver — including go-live opening balances."),
            T("GL-02 — ห้ามบันทึกเข้างวดที่ปิดแล้ว และผู้ปิดงวดต้องต่างจากผู้เริ่มงวด",
              "GL-02 — Posting into a closed period is blocked, and the person who closes it differs from the one who opened it."),
            T("REC-04 — ชุดกระทบยอดบัญชีคุมสิ้นงวดผูกลูกหนี้ เจ้าหนี้ สินค้าคงคลัง และรายได้รับล่วงหน้าไว้ในมุมมองเดียว",
              "REC-04 — A period-end control-account pack ties receivables, payables, inventory and deferred revenue in one view."),
            T("GL-25 / GL-26 — การวิเคราะห์ความผันแปรบังคับคำอธิบายและการลงนาม และรายการตรวจสอบการเปิดเผยข้อมูลตามมาตรฐาน",
              "GL-25 / GL-26 — Variance analysis requires explanations and sign-off, and a disclosure checklist follows the standards."),
        ],
        "wow":[
            T("ยอดยกมาตอนเริ่มระบบผ่านการอนุมัติแบบผู้ทำและผู้อนุมัติเช่นกัน รายการที่มีสาระสำคัญที่สุดจึงไม่ถูกตั้งโดยคนเดียว","Opening balances go through the same maker-checker, so the most material entries are not set by a single person."),
            T("ห้องควบคุมการปิดงวดตอบคำถามเดียวว่าพร้อมปิดหรือยัง ด้วยสถานะเขียว-แดง โดยไม่ต้องเปิดหลายหน้าจอ","The close cockpit answers one question — are we ready to close — in red and green, without opening many screens."),
            T("การวิเคราะห์ความผันแปรที่บังคับคำอธิบายและรายการตรวจสอบการเปิดเผยข้อมูลคือหลักฐานการควบคุมที่พร้อมใช้","Variance analysis with mandatory explanations and a disclosure checklist form ready-made control evidence."),
            T("งบกระแสเงินสดทั้งสามรูปแบบกระทบยอดกับเงินสดจริงโดยโครงสร้าง","All three cash-flow statements reconcile to actual cash by construction."),
        ],
        "routes":["/accounting","/chart-of-accounts","/finance/close-cockpit","/close/flux","/close/disclosure"]})

    # 13 — Multi-GAAP, Consolidation & FX
    S.append({"t":"mod_over","accent":"violet","glyph":"⧉","tag":None,
        "family":T("หลายมาตรฐานบัญชี งบรวม และอัตราแลกเปลี่ยน","Multi-GAAP, Consolidation & FX"),
        "title":T("บันทึกครั้งเดียว รายงานได้หลายมาตรฐาน พร้อมงบรวมระดับสากล","Post once, report under many standards, with international consolidation"),
        "positioning":T("สถาปัตยกรรมบัญชีแยกหลายชุดที่บันทึกครั้งเดียวเข้าทุกชุด แต่แยกรายการปรับปรุงเฉพาะชุด งบรวมระดับกลุ่มรองรับการแปลงค่าสองอัตรา ผลต่างจากการแปลงค่าในกำไรขาดทุนเบ็ดเสร็จอื่น และงบกระแสเงินสดรวม การตีมูลค่าอัตราแลกเปลี่ยนทำอัตโนมัติพร้อมการกลับรายการ",
                        "A parallel-ledger architecture posts once into every ledger yet isolates adjustments to a single one. Group consolidation supports dual-rate translation, a cumulative translation adjustment in other comprehensive income, and a consolidated cash-flow statement. FX revaluation runs automatically with auto-reversal."),
        "features":[
            (T("บัญชีแยกหลายชุด","Parallel ledgers"),
             T("รองรับมาตรฐาน TFRS ภาษี และ IFRS โดยรายการที่ใช้ร่วมเข้าทุกชุด และรายการปรับปรุงเข้าชุดเดียว","Support TFRS, tax and IFRS bases, where shared entries reach every ledger and adjustments post to just one.")),
            (T("การเปรียบเทียบระหว่างมาตรฐาน","Standard comparison"),
             T("เทียบฐานบัญชีและฐานภาษี โดยรายการที่ใช้ร่วมหักล้างกัน เหลือเฉพาะผลต่างจริงเพื่อป้อนภาษีเงินได้รอตัดบัญชี","Compare accounting and tax bases; shared entries cancel, leaving the real difference to feed deferred tax.")),
            (T("รายการระหว่างกิจการ","Intercompany transactions"),
             T("บันทึกสองด้านด้วยบัญชีลูกหนี้-เจ้าหนี้ระหว่างกัน พร้อมการชำระและการหักล้างเมื่อกระทบยอดตรงกัน","Post both sides with due-from and due-to accounts, with settlement and elimination when balances agree.")),
            (T("การจัดทำงบรวม","Consolidation"),
             T("รวมกิจการตามสัดส่วนการถือหุ้น พร้อมส่วนได้เสียที่ไม่มีอำนาจควบคุมและรายการตัดบัญชี โดยตรวจสอบความสมดุลของงบทดลองก่อนบันทึก","Consolidate by ownership with non-controlling interest and eliminations, asserting a balanced trial balance before posting.")),
            (T("การแปลงค่าสองอัตรา","Dual-rate translation"),
             T("แปลงงบกำไรขาดทุนด้วยอัตราเฉลี่ยและงบแสดงฐานะการเงินด้วยอัตราปิด โดยพักผลต่างในกำไรขาดทุนเบ็ดเสร็จอื่น","Translate the income statement at the average rate and the balance sheet at the closing rate, parking the difference in other comprehensive income.")),
            (T("การตีมูลค่าอัตราแลกเปลี่ยน","FX revaluation"),
             T("ตีมูลค่าลูกหนี้-เจ้าหนี้สกุลต่างประเทศที่ยังไม่ชำระ พร้อมกลับรายการต้นเดือนถัดไปโดยอัตโนมัติ","Revalue open foreign-currency receivables and payables, auto-reversing at the start of the next month.")),
        ]})
    S.append({"t":"mod_ctrl","accent":"violet",
        "family":T("หลายมาตรฐานบัญชี งบรวม และอัตราแลกเปลี่ยน","Multi-GAAP, Consolidation & FX"),
        "title":T("งบรวมข้ามสกุลเงินระดับสากลที่สมดุลเสมอ","International cross-currency consolidation that always balances"),
        "controls":[
            T("GAAP-02 — รายการปรับปรุงต่อชุดบัญชีต้องผ่านการอนุมัติแบบผู้ทำและผู้อนุมัติ",
              "GAAP-02 — Per-ledger adjustments must pass maker-checker approval."),
            T("CON-03 — หากงบทดลองรวมไม่สมดุล ระบบจะยกเลิกการบันทึกทั้งหมด และการบันทึกต้องมีผู้อนุมัติที่สอง",
              "CON-03 — If the consolidated trial balance does not balance, the whole run is rolled back, and posting requires a second approver."),
            T("REC-03 — การกระทบยอดรายการระหว่างกิจการต้องได้รับการลงนามก่อนจัดทำงบรวม",
              "REC-03 — Intercompany reconciliation must be signed off before a consolidation run."),
            T("FX-04 — อัตราแลกเปลี่ยนที่ป้อนด้วยมือจะยังใช้ไม่ได้จนกว่าจะได้รับอนุมัติ ป้องกันความผิดพลาดในการป้อน",
              "FX-04 — A manually entered rate is unusable until approved, guarding against keying errors."),
        ],
        "wow":[
            T("บันทึกครั้งเดียวได้หลายมาตรฐาน โดยแยกเฉพาะรายการปรับปรุง ผลต่างระหว่างบัญชีและภาษีจึงวัดได้อย่างสะอาด","Post once for several standards, isolating only the adjustments, so the book-tax difference is measured cleanly."),
            T("การแปลงค่าสองอัตราพร้อมผลต่างในกำไรขาดทุนเบ็ดเสร็จอื่นและงบกระแสเงินสดรวมตามมาตรฐานสากล","Dual-rate translation with a cumulative adjustment in other comprehensive income and a consolidated cash-flow statement, to international standards."),
            T("หากรายการตัดบัญชีทำให้งบรวมไม่สมดุล ระบบจะยกเลิกทั้งหมด งบกลุ่มจึงไม่มีทางไม่สมดุลอย่างเงียบ ๆ","If eliminations unbalance the group, the run is rolled back, so the consolidated statements can never be quietly out of balance."),
            T("อัตราแลกเปลี่ยนที่ผิดจะบันทึกไม่ได้ เพราะใช้เฉพาะอัตราที่อนุมัติแล้วในการตีมูลค่าและจัดทำรายงาน","A wrong rate cannot post, because only approved rates are used for revaluation and reporting."),
        ],
        "routes":["/consolidation","/intercompany","/fx","/ic-reconciliation"]})

    # 14 — Revenue Recognition
    S.append({"t":"mod_over","accent":"green","glyph":"◕","tag":None,
        "family":T("การรับรู้รายได้","Revenue Recognition"),
        "title":T("การรับรู้รายได้ตามมาตรฐานห้าขั้นตอนอย่างครบถ้วน","Five-step revenue recognition, in full"),
        "positioning":T("เครื่องยนต์รับรู้รายได้ตามมาตรฐาน TFRS 15 และ IFRS 15 ครบทั้งห้าขั้นตอน ครอบคลุมสินทรัพย์และหนี้สินตามสัญญา การเรียกเก็บตามความคืบหน้า สิ่งตอบแทนผันแปรพร้อมข้อจำกัด การเปลี่ยนแปลงสัญญา องค์ประกอบด้านการเงิน และชุดการเปิดเผยข้อมูล โดยดุลพินิจของฝ่ายบริหารทุกจุดถูกบันทึกและอนุมัติแบบผู้ทำและผู้อนุมัติ",
                        "A revenue engine that implements TFRS 15 and IFRS 15 across all five steps, covering contract assets and liabilities, progress billing, variable consideration with constraint, contract modifications, a financing component and the disclosure pack. Every management judgement is recorded and approved through maker-checker."),
        "features":[
            (T("เครื่องยนต์ห้าขั้นตอน","Five-step engine"),
             T("ระบุสัญญาและภาระที่ต้องปฏิบัติ จัดสรรราคาตามราคาขายแยก และรับรู้รายได้ผ่านการบันทึกบัญชีที่ควบคุม","Identify contracts and performance obligations, allocate by standalone selling price, and recognise through controlled postings.")),
            (T("สินทรัพย์และหนี้สินตามสัญญา","Contract assets & liabilities"),
             T("แยกการเรียกเก็บออกจากการรับรู้ โดยการรับรู้ที่ล้ำหน้าจะเป็นสินทรัพย์ตามสัญญา และการเรียกเก็บต้องมีผู้อนุมัติที่สอง","Decouple billing from recognition; recognition ahead of billing becomes a contract asset, and billing requires a second approver.")),
            (T("สิ่งตอบแทนผันแปร","Variable consideration"),
             T("ประมาณด้วยมูลค่าคาดหวังหรือค่าที่เป็นไปได้มากที่สุด พร้อมข้อจำกัด และปรับปรุงแบบสะสมเมื่ออนุมัติ","Estimate by expected value or most-likely amount, with a constraint, adjusting cumulatively on approval.")),
            (T("การเปลี่ยนแปลงสัญญา","Contract modifications"),
             T("จัดประเภทเป็นสัญญาแยก การปรับไปข้างหน้า หรือการปรับสะสม โดยการจัดประเภทเองคือการควบคุม","Classify as a separate contract, prospective or cumulative catch-up, where the classification itself is the control.")),
            (T("องค์ประกอบด้านการเงิน","Financing component"),
             T("คิดลดเป็นมูลค่าปัจจุบันและทยอยรับรู้ดอกเบี้ยตามอัตราดอกเบี้ยที่แท้จริง","Discount to present value and unwind interest at the effective interest rate.")),
            (T("ชุดการเปิดเผยข้อมูล","Disclosure pack"),
             T("จัดทำการกระทบยอดหนี้สินตามสัญญาและมูลค่างานที่ยังไม่รับรู้ ซึ่งกระทบยอดกับบัญชีแยกประเภท","Produce the contract-liability rollforward and remaining performance obligations, reconciled to the ledger.")),
        ]})
    S.append({"t":"mod_ctrl","accent":"green",
        "family":T("การรับรู้รายได้","Revenue Recognition"),
        "title":T("ดุลพินิจของฝ่ายบริหารทุกจุดต้องมีผู้อนุมัติที่สอง","Every management judgement needs a second approver"),
        "controls":[
            T("REV-24 — การเรียกเก็บตามความคืบหน้าต้องทำโดยผู้อื่นที่ไม่ใช่ผู้จัดทำ",
              "REV-24 — Milestone billing must be done by someone other than the person who prepared it."),
            T("REV-25 / REV-26 — การประมาณสิ่งตอบแทนผันแปรและการเปลี่ยนแปลงสัญญาต้องได้รับอนุมัติก่อนขับเคลื่อนรายได้",
              "REV-25 / REV-26 — Variable-consideration estimates and contract modifications must be approved before driving revenue."),
            T("REV-27 — ดุลพินิจอัตราคิดลดขององค์ประกอบด้านการเงินต้องผ่านการอนุมัติแบบผู้ทำและผู้อนุมัติ",
              "REV-27 — The discount-rate judgement for the financing component passes maker-checker approval."),
            T("REC-01 — ยอดรายได้รับล่วงหน้ากระทบยอดกับบัญชีแยกประเภทเป็นประจำ",
              "REC-01 — Deferred revenue reconciles to the ledger on a regular basis."),
        ],
        "wow":[
            T("มาตรฐานการรับรู้รายได้ครบทุกด้าน ทั้งสินทรัพย์-หนี้สินตามสัญญา สิ่งตอบแทนผันแปร การเปลี่ยนแปลงสัญญา และองค์ประกอบด้านการเงิน","The revenue standard implemented in full — contract assets and liabilities, variable consideration, modifications and a financing component."),
            T("การจัดประเภทสินทรัพย์ตามสัญญากระทบยอดโดยโครงสร้าง ผลรวมของสินทรัพย์เท่ากับรายได้ที่รับรู้หักการเรียกเก็บ","Contract-asset reclassification ties by construction: the asset equals revenue recognised less amounts billed."),
            T("การประมาณที่ยังไม่อนุมัติจะขับเคลื่อนรายได้ไม่ได้ ทุกดุลพินิจจึงเป็นหลักฐานที่พร้อมให้ตรวจสอบ","An unapproved estimate cannot drive revenue, so every judgement becomes audit-ready evidence."),
            T("การกระทบยอดในการเปิดเผยข้อมูลสร้างขึ้นจากรายการบัญชีจริง จึงตรงกันโดยโครงสร้าง","The disclosure rollforward is reconstructed from actual journal lines, so it reconciles by construction."),
        ],
        "routes":["/revenue","/api/revenue/contracts","/api/revenue/disclosure"]})

    # 15 — Fixed Assets, Leases & Deferred Tax
    S.append({"t":"mod_over","accent":"cyan","glyph":"▤","tag":None,
        "family":T("สินทรัพย์ถาวร สัญญาเช่า และภาษีรอตัดบัญชี","Fixed Assets, Leases & Deferred Tax"),
        "title":T("วงจรสินทรัพย์ครบถ้วน พร้อมมาตรฐานสัญญาเช่าและภาษีเงินได้รอตัดบัญชี","A full asset lifecycle, with lease accounting and deferred tax"),
        "positioning":T("ครอบคลุมวงจรสินทรัพย์ตั้งแต่การบันทึกเป็นทรัพย์สินจากการรับของ การคิดค่าเสื่อมราคา การตีราคาใหม่และการด้อยค่า จนถึงการจำหน่าย พร้อมการบัญชีสัญญาเช่าตามมาตรฐาน IFRS 16 ทั้งฝั่งผู้เช่าและผู้ให้เช่า งานซ่อมบำรุง และสมุดค่าเสื่อมทางภาษีคู่ขนานที่ป้อนภาษีเงินได้รอตัดบัญชี",
                        "It spans the asset lifecycle from capitalisation at goods receipt through depreciation, revaluation and impairment to disposal, with IFRS 16 lease accounting for both lessee and lessor, maintenance work orders, and a parallel tax-depreciation book that feeds deferred tax."),
        "features":[
            (T("ทะเบียนและการบันทึกเป็นทรัพย์สิน","Register & capitalisation"),
             T("บันทึกทรัพย์สินจากการรับของโดยตรง พร้อมสืบย้อนตั้งแต่คำขอซื้อถึงใบสั่งซื้อและการรับของ","Capitalise assets directly from goods receipt, with traceability from requisition to purchase order and receipt.")),
            (T("ค่าเสื่อมราคา","Depreciation"),
             T("คำนวณค่าเสื่อมรายเดือนแบบไม่ซ้ำต่อกิจการต่องวด และจำกัดไม่ให้เกินมูลค่าคงเหลือ","Compute monthly depreciation idempotently per company and period, capped at residual value.")),
            (T("การตีราคาใหม่และการด้อยค่า","Revaluation & impairment"),
             T("ตีราคาเพิ่มเข้าส่วนเกินทุน และเมื่อจำหน่ายจะโอนส่วนเกินเข้ากำไรสะสมโดยตรง ผ่านการอนุมัติที่สอง","Revalue upward into a surplus reserve and, on disposal, recycle it directly to retained earnings, via second approval.")),
            (T("สัญญาเช่าผู้เช่าและผู้ให้เช่า","Lessee & lessor leases"),
             T("รับรู้สินทรัพย์สิทธิการใช้และหนี้สินตามมูลค่าปัจจุบัน พร้อมแถบกระทบยอดหนี้สินสัญญาเช่าที่หน้าจอ","Recognise right-of-use assets and liabilities at present value, with a lease-liability reconciliation banner on screen.")),
            (T("งานซ่อมบำรุงสินทรัพย์","Asset maintenance"),
             T("จัดการใบสั่งงานซ่อมและแผนบำรุงรักษาเชิงป้องกัน พร้อมตัวชี้วัดความน่าเชื่อถือ","Manage repair work orders and preventive-maintenance schedules, with reliability metrics.")),
            (T("ภาษีเงินได้รอตัดบัญชี","Deferred tax"),
             T("จัดทำสมุดค่าเสื่อมทางภาษีคู่ขนานที่ป้อนสินทรัพย์และหนี้สินภาษีรอตัดบัญชีจากผลต่างจริง ผ่านการอนุมัติที่สอง","Maintain a parallel tax-depreciation book that feeds deferred-tax assets and liabilities from real differences, via second approval.")),
        ]})
    S.append({"t":"mod_ctrl","accent":"cyan",
        "family":T("สินทรัพย์ถาวร สัญญาเช่า และภาษีรอตัดบัญชี","Fixed Assets, Leases & Deferred Tax"),
        "title":T("มาตรฐานสัญญาเช่าทั้งสองฝั่ง พร้อมสมุดภาษีจริง","Lease accounting on both sides, with a real tax book"),
        "controls":[
            T("FA-08 / FA-09 — การตีราคาใหม่และการจำหน่ายทรัพย์สินต้องผ่านการอนุมัติแบบผู้ทำและผู้อนุมัติ",
              "FA-08 / FA-09 — Asset revaluation and disposal pass maker-checker approval."),
            T("FA-10 — การบันทึกเป็นทรัพย์สินจากการรับของต้องมีผู้ร้องขอและผู้อนุมัติคนละคน",
              "FA-10 — Capitalising from goods receipt requires a distinct requester and approver."),
            T("LSE-01 — หนี้สินตามสัญญาเช่ากระทบยอดกับตารางการชำระที่หน้าจอ",
              "LSE-01 — The lease liability reconciles to the payment schedule on screen."),
            T("TAX-06 — การบันทึกภาษีเงินได้รอตัดบัญชีต้องมีผู้ดำเนินการและผู้บันทึกคนละคน",
              "TAX-06 — Posting deferred tax requires a distinct runner and poster."),
        ],
        "wow":[
            T("การบัญชีสัญญาเช่าตามมาตรฐาน IFRS 16 ทั้งฝั่งผู้เช่าและผู้ให้เช่า พร้อมแถบกระทบยอดหนี้สินที่หน้าจอ","IFRS 16 lease accounting for both lessee and lessor, with a liability reconciliation banner on screen."),
            T("สมุดค่าเสื่อมทางภาษีคู่ขนานป้อนภาษีเงินได้รอตัดบัญชีจากผลต่างจริง ไม่ต้องปรับปรุงด้วยมือ","A parallel tax-depreciation book feeds deferred tax from real differences, with no manual adjustment."),
            T("การบันทึกเป็นทรัพย์สินจากการรับของสืบย้อนได้ตลอดสาย และตัดรายการทรัพย์สินออกจากสินค้าคงคลังโดยอัตโนมัติ","Capitalisation from goods receipt is fully traceable and removes the capital line from inventory automatically."),
            T("การตรวจนับด้วยการสแกนคิวอาร์และรายงานข้อยกเว้นคือการควบคุมเชิงตรวจจับการมีอยู่จริงของสินทรัพย์","QR-scan verification and an exceptions report form a detective control over the physical existence of assets."),
        ],
        "routes":["/assets","/leases","/eam","/deferred-tax"]})

    # 16 — Tax & Compliance
    S.append({"t":"mod_over","accent":"coral","glyph":"₧","tag":T("มาตรฐานไทย","THAI-COMPLIANT"),
        "family":T("ภาษีและการปฏิบัติตามกฎหมาย","Tax & Compliance"),
        "title":T("ชุดภาษีไทยครบถ้วน พร้อมใบกำกับภาษีอิเล็กทรอนิกส์ที่ลงลายมือชื่อดิจิทัล","A complete Thai tax suite with digitally signed e-Tax invoices"),
        "positioning":T("ครอบคลุมภาษีมูลค่าเพิ่ม ภาษีหัก ณ ที่จ่าย ใบกำกับภาษีตามกฎหมาย ใบกำกับภาษีอิเล็กทรอนิกส์ที่ลงลายมือชื่อดิจิทัล แบบแสดงรายการภาษี และการประมาณการภาษีเงินได้พร้อมการกระทบยอดอัตราภาษีที่แท้จริง โดยทุกรายการภาษีกระทบยอดกับบัญชีแยกประเภทก่อนการยื่น",
                        "It covers value-added tax, withholding tax, statutory tax invoices, digitally signed e-Tax invoices, tax returns and the income-tax provision with an effective-tax-rate reconciliation — and every tax figure reconciles to the ledger before filing."),
        "features":[
            (T("การตั้งค่าอัตราภาษีต่อประเทศ","Per-country tax rates"),
             T("กำหนดผู้ให้บริการภาษีต่อประเทศได้ โดยไม่มีอัตราที่ตายตัวในโปรแกรม","Configure a tax provider per country, with no rate hard-coded in the software.")),
            (T("ใบกำกับภาษี","Tax invoices"),
             T("ออกเลขที่ต่อเนื่องไม่ขาดช่วง จัดการการยกเลิกโดยเก็บเลขที่ไว้ และแปลงใบกำกับอย่างย่อเป็นแบบเต็มได้","Issue gapless numbers, handle voids while retaining the number, and convert abbreviated invoices to full ones.")),
            (T("ใบกำกับภาษีอิเล็กทรอนิกส์","Electronic tax invoices"),
             T("สร้างเอกสารตามมาตรฐานพร้อมลายมือชื่อดิจิทัลและฝังไฟล์ในเอกสาร โดยส่งซ้ำไม่ได้เมื่อได้รับการตอบรับแล้ว","Generate standards-based documents with a digital signature and embedded file, and do not resend once accepted.")),
            (T("ใบเพิ่มหนี้-ลดหนี้และภาษีนำเข้า","Credit notes & reverse charge"),
             T("ออกใบเพิ่มหนี้และลดหนี้พร้อมอ้างอิงต้นฉบับ และประเมินภาษีบริการนำเข้าด้วยตนเอง","Issue credit and debit notes referencing the original, and self-assess tax on imported services.")),
            (T("ภาษีหัก ณ ที่จ่าย","Withholding tax"),
             T("คำนวณและออกหนังสือรับรอง พร้อมไฟล์ยื่นอิเล็กทรอนิกส์ที่ใช้รูปแบบวันที่และการเข้ารหัสแบบไทย","Compute and issue certificates, with an e-filing file that uses Thai date and encoding conventions.")),
            (T("การประมาณการภาษีเงินได้","Income-tax provision"),
             T("คำนวณจากกำไรก่อนภาษี ปรับรายการถาวรและชั่วคราว พร้อมกระทบยอดอัตราภาษีที่แท้จริงโดยโครงสร้าง","Compute from pretax profit with permanent and temporary adjustments, reconciling the effective tax rate by construction.")),
        ]})
    S.append({"t":"mod_ctrl","accent":"coral",
        "family":T("ภาษีและการปฏิบัติตามกฎหมาย","Tax & Compliance"),
        "title":T("ยื่นต่อกรมสรรพากรได้จริง โดยไม่ต้องแก้ไขรูปแบบไฟล์","File with the Revenue Department directly, with no format fixes"),
        "controls":[
            T("TAX-07 — ใบเพิ่มหนี้และลดหนี้ต้องผ่านการอนุมัติแบบผู้ทำและผู้อนุมัติก่อนเข้าสู่แบบแสดงรายการ",
              "TAX-07 — Credit and debit notes pass maker-checker approval before entering the return."),
            T("TAX-06 / TAX-11 — การประมาณการภาษีต้องมีผู้ดำเนินการและผู้บันทึกคนละคน",
              "TAX-06 / TAX-11 — Tax provisioning requires a distinct runner and poster."),
            T("TAX-04 — แบบแสดงรายการภาษีมูลค่าเพิ่มกระทบยอดกับบัญชีแยกประเภทก่อนการยื่น",
              "TAX-04 — The VAT return reconciles to the ledger before filing."),
            T("TAX-01 — อัตราภาษีมาจากการตั้งค่าต่อประเทศ ไม่มีอัตราตายตัวในโปรแกรม",
              "TAX-01 — Tax rates come from per-country configuration, with none hard-coded."),
        ],
        "wow":[
            T("ใบกำกับภาษีอิเล็กทรอนิกส์ตามมาตรฐาน พร้อมลายมือชื่อดิจิทัลและการฝังไฟล์ ยื่นต่อหน่วยงานได้จริงและไม่สูญหายแม้ผู้ให้บริการขัดข้อง","Standards-based e-Tax invoices with a digital signature and embedded file, genuinely fileable and durable even if a provider fails."),
            T("ครอบคลุมภาษีไทยครบถ้วน ทั้งภาษีมูลค่าเพิ่ม ภาษีนำเข้า ภาษีธุรกิจเฉพาะ และภาษีหัก ณ ที่จ่าย โดยกระทบยอดกับบัญชีทุกตัว","Complete Thai tax coverage — VAT, reverse charge, specific business tax and withholding — all reconciled to the ledger."),
            T("ไฟล์ยื่นอิเล็กทรอนิกส์ใช้รูปแบบวันที่และการเข้ารหัสแบบไทย จึงยื่นได้โดยไม่ต้องแก้ไข","E-filing files use Thai date and encoding conventions, so they file without editing."),
            T("การประมาณการภาษีเงินได้พร้อมการกระทบยอดอัตราภาษีที่แท้จริง ทำงานร่วมกับสมุดภาษีเงินได้รอตัดบัญชี","The income-tax provision with an effective-rate reconciliation works together with the deferred-tax book."),
        ],
        "routes":["/tax/invoices","/tax/wht","/tax/reports","/tax/provision","/einvoice"]})

    # 17 — Treasury
    S.append({"t":"mod_over","accent":"teal","glyph":"◈","tag":None,
        "family":T("การบริหารเงินสดและเครื่องมือทางการเงิน","Treasury & Financial Instruments"),
        "title":T("ศูนย์ควบคุมสภาพคล่องและตราสารการเงินตามมาตรฐานสากล","A liquidity and financial-instruments control centre to international standards"),
        "positioning":T("รวมการจัดการเงินสดหน้าร้าน การนำฝากธนาคาร การกระทบยอดธนาคาร และห้องควบคุมเงินสดที่พยากรณ์ล่วงหน้าสิบสามสัปดาห์ พร้อมทะเบียนเครื่องมือทางการเงินตามมาตรฐาน IFRS 9 ครอบคลุมหนี้สิน เงินลงทุน การบัญชีป้องกันความเสี่ยง และการรวมศูนย์เงินสด",
                        "It brings together front-of-house cash handling, bank deposits, bank reconciliation and a cash-command board with a thirteen-week forecast, plus an IFRS 9 financial-instruments register covering debt, investments, hedge accounting and cash pooling."),
        "features":[
            (T("เงินสดหน้าร้านและการนำฝาก","Cash handling & deposits"),
             T("เปิด-ปิดกะพร้อมกระทบยอดส่วนต่าง และนำเงินเข้าฝากธนาคารเป็นชุดพร้อมแสดงความเสี่ยงเงินสดที่ยังไม่นำฝาก","Open and close tills with variance reconciliation, and batch bank deposits, surfacing undeposited-cash exposure.")),
            (T("การกระทบยอดธนาคาร","Bank reconciliation"),
             T("นำเข้ารายการเดินบัญชีและจับคู่ด้วยเครื่องยนต์เดียวกัน โดยรายการค่าธรรมเนียมเป็นฉบับร่างจนกว่าผู้อื่นจะอนุมัติ","Import statements and match with a shared engine, holding fee entries as drafts until another person approves.")),
            (T("ห้องควบคุมเงินสด","Cash-command board"),
             T("แสดงฐานะเงินสด พยากรณ์สิบสามสัปดาห์ จุดต่ำสุดของสภาพคล่อง และความเสี่ยงจากอัตราแลกเปลี่ยนในหน้าจอเดียว","Show the cash position, a thirteen-week forecast, the liquidity trough and FX exposure on one screen.")),
            (T("หนี้สินและเงินกู้","Debt & borrowings"),
             T("จัดการวงเงิน การเบิกถอน และดอกเบี้ยตามอัตราที่แท้จริง พร้อมติดตามเงื่อนไขสัญญาและการผิดเงื่อนไข","Manage facilities, drawdowns and effective-interest accrual, tracking covenants and breaches.")),
            (T("เงินลงทุน","Investments"),
             T("จัดประเภทตามมาตรฐาน พร้อมราคาตลาดที่อนุมัติแล้ว และแยกผลกำไรเข้ากำไรขาดทุนเบ็ดเสร็จอื่นหรือกำไรขาดทุน","Classify per the standard, with approved market prices, splitting gains into other comprehensive income or profit or loss.")),
            (T("การบัญชีป้องกันความเสี่ยง","Hedge accounting"),
             T("กำหนดความสัมพันธ์และทดสอบประสิทธิผล โดยไม่บันทึกเข้ากำไรขาดทุนเบ็ดเสร็จอื่นจนกว่าจะอนุมัติและมีประสิทธิผล","Designate relationships and test effectiveness, deferring OCI accounting until approved and effective.")),
        ]})
    S.append({"t":"mod_ctrl","accent":"teal",
        "family":T("การบริหารเงินสดและเครื่องมือทางการเงิน","Treasury & Financial Instruments"),
        "title":T("ทะเบียนเครื่องมือทางการเงินครบตามมาตรฐาน IFRS 9","A financial-instruments register complete to IFRS 9"),
        "controls":[
            T("TRE-01 ถึง TRE-05 — เครื่องมือทางการเงินทุกประเภทต้องมีผู้สร้างและผู้อนุมัติคนละคน",
              "TRE-01 to TRE-05 — Every financial instrument requires a distinct creator and approver."),
            T("REC-02 — การกระทบยอดธนาคารต้องมีผู้จัดเตรียมและผู้รับรองคนละคน",
              "REC-02 — Bank reconciliation requires a distinct preparer and certifier."),
            T("R23 — หน้าที่ด้านการบริหารเงินสดถูกแยกออกจากอำนาจอนุมัติ",
              "R23 — Treasury duties are segregated from approval authority."),
            T("G9 — การสร้างบัญชีธนาคารต้องผ่านการอนุมัติก่อนใช้งาน",
              "G9 — Creating a bank account requires approval before use."),
        ],
        "wow":[
            T("ทะเบียนเครื่องมือทางการเงินครบตามมาตรฐาน IFRS 9 ทั้งหนี้สิน เงินลงทุน การป้องกันความเสี่ยง และการรวมศูนย์เงินสด","A financial-instruments register complete to IFRS 9 — debt, investments, hedging and cash pooling."),
            T("เครื่องยนต์จับคู่เดียวใช้ทั้งการกระทบยอดธนาคารและการกระทบยอดพร้อมเพย์หน้าร้าน","One matching engine serves both bank reconciliation and store-level PromptPay reconciliation."),
            T("พยากรณ์เงินสดสิบสามสัปดาห์ จุดต่ำสุดของสภาพคล่อง และความเสี่ยงจากอัตราแลกเปลี่ยน อยู่ในหน้าจอเดียว","A thirteen-week cash forecast, the liquidity trough and FX exposure sit on one screen."),
            T("เงินกู้ระหว่างกิจการและดอกเบี้ยจะหักล้างเมื่อจัดทำงบรวม กลุ่มจึงนับต้นทุนและรายได้ทางการเงินเป็นศูนย์","Intercompany loans and interest eliminate on consolidation, so the group nets finance cost and income to zero."),
        ],
        "routes":["/finance/treasury","/bank","/reconciliation","/cash-banking","/financial-health"]})

    # 18 — HR / HCM
    S.append({"t":"mod_over","accent":"violet","glyph":"◔","tag":None,
        "family":T("การบริหารทรัพยากรบุคคล","Human Capital Management"),
        "title":T("การบริหารบุคลากรครบวงจรบนข้อมูลพนักงานชุดเดียว","End-to-end people management on a single employee record"),
        "positioning":T("ชุดการบริหารทรัพยากรบุคคลที่สร้างบนข้อมูลพนักงานชุดเดียว ครอบคลุมโครงสร้างองค์กร การสรรหา การรับและพ้นสภาพ โครงสร้างค่าตอบแทน การฝึกอบรม การประเมินผล และบริการตนเองของพนักงาน โดยทุกเส้นทางการอนุมัติแยกผู้อนุมัติออกจากผู้ถูกประเมิน และทุกตารางแยกข้อมูลตามกิจการ",
                        "A human-capital suite built on one employee record, covering org structure, recruiting, onboarding and offboarding, compensation, training, appraisals and employee self-service. Every approval separates the approver from the subject, and every table is isolated by company."),
        "features":[
            (T("โครงสร้างองค์กรและตำแหน่ง","Org structure & positions"),
             T("จัดลำดับหน่วยงานและตำแหน่งที่มีอัตรากำลังกำหนดไว้ พร้อมผังองค์กรที่แสดงอัตราที่บรรจุเทียบกับที่อนุมัติ","Organise departments and budgeted positions, with an org chart showing filled versus approved headcount.")),
            (T("การสรรหาและว่าจ้าง","Recruiting & hiring"),
             T("จัดการใบขออัตรากำลัง กลุ่มผู้สมัคร และการเสนอจ้าง โดยการว่าจ้างจะแปลงข้อเสนอที่อนุมัติแล้วเป็นพนักงานจริง","Manage requisitions, a candidate pool and offers, where hiring converts an approved offer into a real employee.")),
            (T("การรับและพ้นสภาพ","Onboarding & offboarding"),
             T("ใช้รายการตรวจสอบที่นำกลับมาใช้ซ้ำได้ พร้อมด่านตรวจการเพิกถอนสิทธิ์เข้าถึงเมื่อพนักงานพ้นสภาพ","Use reusable checklists, with an access-revocation gate when an employee leaves.")),
            (T("โครงสร้างค่าตอบแทนและสวัสดิการ","Compensation & benefits"),
             T("จัดการช่วงค่าจ้างตามระดับงาน โดยการเปลี่ยนค่าตอบแทนต้องอยู่ในช่วงและมีผู้อนุมัติที่สอง","Manage pay bands by grade, where compensation changes must stay within band and require a second approver.")),
            (T("การฝึกอบรมและใบรับรอง","Training & certifications"),
             T("จัดหลักสูตรและติดตามใบรับรองที่มีวันหมดอายุ พร้อมรายงานการปฏิบัติตามข้อกำหนดเชิงตรวจจับ","Run courses and track certifications with expiry, with a detective compliance report.")),
            (T("บริการตนเองของพนักงาน","Employee self-service"),
             T("พนักงานปรับปรุงข้อมูลของตนเองได้ โดยข้อมูลอ่อนไหวถูกพักไว้ให้ฝ่ายบุคคลอนุมัติ ส่วนข้อมูลติดต่อปรับได้ทันที","Employees maintain their own data, with sensitive fields held for HR approval and contact details applied instantly.")),
        ]})
    S.append({"t":"mod_ctrl","accent":"violet",
        "family":T("การบริหารทรัพยากรบุคคล","Human Capital Management"),
        "title":T("อัตรากำลังเกินจากภายในไม่ได้","Headcount cannot be exceeded from the inside"),
        "controls":[
            T("HR-01 — การบรรจุเกินอัตรากำลังที่อนุมัติจะถูกระงับ และการยกเว้นต้องได้รับอนุมัติจากผู้บริหารพร้อมบันทึกไว้",
              "HR-01 — Filling beyond approved headcount is blocked, and an override requires executive approval and is logged."),
            T("HR-05 — การพ้นสภาพจะปิดไม่ได้จนกว่าการเพิกถอนสิทธิ์เข้าถึงจะเสร็จสมบูรณ์",
              "HR-05 — Offboarding cannot complete until access revocation is finished."),
            T("HR-06 — การเปลี่ยนค่าตอบแทนต้องอยู่ในช่วงและมีผู้อนุมัติที่สอง",
              "HR-06 — Compensation changes must stay within band and require a second approver."),
            T("HR-08 — การเปลี่ยนข้อมูลอ่อนไหวของพนักงานต้องได้รับการอนุมัติจากฝ่ายบุคคล",
              "HR-08 — Changing an employee's sensitive fields requires HR approval."),
        ],
        "wow":[
            T("อัตรากำลังเกินจากภายในไม่ได้ ทุกการบรรจุเกินคือการตัดสินใจของผู้บริหารที่บันทึกและระบุตัวได้","Headcount cannot be exceeded from the inside; every over-establishment hire is an attributable executive decision."),
            T("ด่านตรวจการพ้นสภาพเป็นการควบคุมที่แท้จริง สิทธิ์เข้าถึงของผู้พ้นสภาพต้องถูกเพิกถอนอย่างพิสูจน์ได้ก่อนปิดงาน","The offboarding gate is a genuine control: a leaver's access must be provably removed before the case closes."),
            T("ใบรับรองสร้างขึ้นพร้อมวันหมดอายุโดยอัตโนมัติ การหมดอายุจึงไม่มีทางพลาด","Certifications are minted with an expiry automatically, so a lapse cannot be missed."),
            T("พนักงานเปลี่ยนบัญชีรับเงินของตนเองอย่างเงียบ ๆ ไม่ได้ ต้องผ่านการอนุมัติจากฝ่ายบุคคลอิสระ","Employees cannot silently repoint their own pay; it must pass independent HR approval."),
        ],
        "routes":["/hcm/org","/hcm/recruiting","/hcm/onboarding","/hcm/comp","/hcm/training","/hcm/ess"]})

    # 19 — Payroll (two-panel single)
    S.append({"t":"two_panel","accent":"gold",
        "section":T("เจาะลึกแต่ละโมดูล","Module deep dive"),
        "kicker":T("เงินเดือนและเวลาทำงาน","Payroll & Time"),
        "title":T("เงินเดือนถูกต้องตามกฎหมายไทย พร้อมการควบคุมแบบผู้ทำและผู้อนุมัติ","Thai-statutory payroll under maker-checker control"),
        "left":(T("เครื่องยนต์เงินเดือนไทย","Thai payroll engine"),"₿","gold",[
            (T("คำนวณจากยอดรวมถึงสุทธิ","Gross-to-net"),
             T("คำนวณประกันสังคม ภาษีเงินได้แบบขั้นบันได และกองทุนสำรองเลี้ยงชีพ โดยผ่านการทดสอบ ไม่มีอัตราตายตัว","Compute social security, progressive income tax and provident fund, unit-tested with no ad-hoc rates.")),
            (T("แบบยื่นตามกฎหมาย","Statutory filings"),
             T("จัดทำแบบภาษีหัก ณ ที่จ่ายรายเดือนและรายปี พร้อมตารางหนี้สินที่กระทบยอดกับบัญชี","Produce monthly and annual withholding returns, with a liability schedule reconciled to the ledger.")),
            (T("สลิปเงินเดือน","Payslips"),
             T("สร้างเอกสารที่พิมพ์และส่งได้ โดยปิดบังเลขบัตรประชาชนและจำกัดการเข้าถึงตามหลักคุ้มครองข้อมูล","Generate printable, sendable payslips that mask the citizen ID and restrict access under data-protection rules.")),
            (T("การประมวลผลปริมาณมาก","High-volume processing"),
             T("ประมวลผลพนักงานจำนวนมากนอกเธรดคำขอ โดยไม่ซ้ำต่อกิจการต่องวด","Process large populations off the request thread, idempotent per company and period.")),
        ]),
        "right":(T("การควบคุมและเวลาทำงาน","Control & time"),"◆","coral",[
            (T("จ่ายเงินให้ตนเองไม่ได้","Cannot pay yourself"),
             T("รอบเงินเดือนบันทึกเป็นฉบับร่างที่ไม่รวมในยอด และการอนุมัติตนเองถูกปฏิเสธแม้กับผู้ดูแลระบบ","A payroll run posts as an excluded draft, and self-approval is rejected even for the administrator.")),
            (T("กฎค่าล่วงเวลา","Overtime rules"),
             T("รองรับอัตราค่าล่วงเวลาแบบขั้นตามกฎหมายคุ้มครองแรงงาน พร้อมการแจ้งเตือนสัดส่วนค่าแรงต่อยอดขาย","Tiered overtime rates aligned to labour law, with labour-to-sales alerting.")),
            (T("ป้องกันการลงเวลาแทนกัน","Anti buddy-punch"),
             T("บันทึกการลงเวลาด้วยรหัส คิวอาร์ หรือใบหน้า พร้อมบล็อกการลงซ้ำและตรวจตำแหน่ง","Capture clock-in by PIN, QR or face, blocking duplicate punches and flagging location.")),
            (T("กระทบยอดกับบัญชีและภาษี","Ties to ledger and filings"),
             T("ตารางหนี้สินกระทบยอดระหว่างยอดค้างในบัญชีกับยอดรวมของรอบเงินเดือนอย่างเป็นอิสระ","The liability schedule reconciles the ledger accrual against an independent payrun total.")),
        ])})

    # 20 — Projects / PPM
    S.append({"t":"mod_over","accent":"teal","glyph":"◨","tag":None,
        "family":T("การบริหารโครงการ","Project & Portfolio Management"),
        "title":T("การบริหารโครงการระดับองค์กร พร้อมการควบคุมวัสดุครบวงจร","Enterprise project management with end-to-end material control"),
        "positioning":T("แพลตฟอร์มบริหารโครงการและพอร์ตโฟลิโอบนแกนโครงการและไปป์ไลน์ ครอบคลุมตั้งแต่การแปลงโอกาสที่ชนะเป็นโครงการ โครงสร้างงานและแผนภูมิแกนต์ อัตราค่าแรง การวิเคราะห์มูลค่าที่ได้รับ เส้นฐาน ทะเบียนความเสี่ยง ศูนย์ปฏิบัติการที่แจ้งเตือนแบบเรียลไทม์ และวงจรควบคุมวัสดุก่อสร้างที่คุมงบประมาณได้จริง",
                        "A project and portfolio platform on the projects-and-pipeline spine, from converting a won opportunity into a project, through work breakdown and Gantt charts, rate cards, earned-value analysis, baselines and risk registers, to a real-time action centre and a construction material-control loop that genuinely enforces budgets."),
        "features":[
            (T("ศูนย์บัญชาการพอร์ตโฟลิโอ","Portfolio command centre"),
             T("แสดงสุขภาพโครงการด้วยดัชนีต้นทุนและกำหนดการ ยอดตามสัญญา ยอดเรียกเก็บ งานระหว่างทำ และการพยากรณ์ล่วงหน้า","Show project health via cost and schedule indices, contract value, billings, work-in-process and a forward forecast.")),
            (T("ศูนย์ปฏิบัติการ","Action centre"),
             T("จัดลำดับสิ่งที่ต้องดำเนินการตามความรุนแรง และแจ้งเตือนทันทีที่โครงการเบี่ยงเบนผ่านช่องทางเรียลไทม์","Rank what needs attention by severity and alert the moment a project drifts, over a real-time channel.")),
            (T("ทรัพยากรและกำลังการผลิต","Resources & capacity"),
             T("จัดการอัตราค่าแรงที่มีผลตามช่วงเวลา ปฏิทินกำลังการผลิต และการเทียบอุปสงค์กับอุปทานของทักษะ","Manage effective-dated rate cards, a capacity calendar and skill supply-versus-demand.")),
            (T("มูลค่าที่ได้รับและกำหนดการ","Earned value & schedule"),
             T("คำนวณดัชนีต้นทุนและกำหนดการ กำหนดการที่ได้รับ และเส้นทางวิกฤต พร้อมความสัมพันธ์และเวลาหน่วง","Compute cost and schedule indices, earned schedule and the critical path, with dependencies and lags.")),
            (T("เส้นฐาน ความรับผิดชอบ และความเสี่ยง","Baselines, RACI & risk"),
             T("ควบคุมการเปลี่ยนเส้นฐาน จัดทำเมทริกซ์ความรับผิดชอบ และทะเบียนความเสี่ยงที่เผยความเสี่ยงสูงที่ยังไม่จัดการ","Control baseline changes, maintain a responsibility matrix and a risk register that surfaces unmitigated high risks.")),
            (T("การควบคุมวัสดุและการสั่งซื้อเพื่อโครงการ","Material control & project buying"),
             T("อนุมัติบัญชีปริมาณงานแบบผู้ทำและผู้อนุมัติ กันงบด้วยการล็อกระดับรายการ และเบิกวัสดุเข้างานระหว่างทำของโครงการ","Approve the bill of quantities via maker-checker, reserve budget under row-level locking, and issue materials into project work-in-process.")),
        ]})
    S.append({"t":"mod_ctrl","accent":"teal",
        "family":T("การบริหารโครงการ","Project & Portfolio Management"),
        "title":T("งบประมาณที่บังคับใช้ได้จริงและปลอดภัยต่อการทำงานพร้อมกัน","Budgets that are genuinely enforced and concurrency-safe"),
        "controls":[
            T("PROJ-04 — ใบบันทึกเวลาที่ลงเป็นต้นทุนค่าแรงต้องมีผู้อนุมัติที่ไม่ใช่ผู้บันทึก",
              "PROJ-04 — Timesheets posted as labour cost require an approver other than the person who logged them."),
            T("PROJ-12 — การสั่งซื้อที่ผูกกับรายการงบประมาณจะกันงบด้วยการล็อกระดับรายการ และเกินงบไม่ได้",
              "PROJ-12 — Purchase orders tied to a budget line reserve budget under row-level locking and cannot exceed it."),
            T("PROJ-13 — การเบิกวัสดุที่เกินงบจะถูกส่งให้ผู้มีอำนาจที่ไม่ใช่ผู้ร้องขออนุมัติ",
              "PROJ-13 — Over-budget material requisitions route to an authoriser other than the requester."),
            T("PROJ-08 — ความเสี่ยงสูงที่ยังไม่จัดการจะปรากฏในศูนย์ปฏิบัติการเชิงตรวจจับ",
              "PROJ-08 — Unmitigated high risks surface in a detective action centre."),
        ],
        "wow":[
            T("ศูนย์ปฏิบัติการแจ้งข้อยกเว้นแบบเรียลไทม์ โครงการที่เข้าสถานะเสี่ยงหรือความเสี่ยงที่ไม่มีการจัดการจะปลุกกล่องงานทันที","The action centre pushes exceptions in real time; a project going red or a risk left unmitigated wakes the inbox at once."),
            T("การบังคับงบปลอดภัยต่อการทำงานพร้อมกัน การล็อกรายการทำให้ใบสั่งซื้อสองใบพร้อมกันเกินงบร่วมกันไม่ได้","Budget enforcement is concurrency-safe; locking a line stops two simultaneous orders from jointly overrunning."),
            T("กำหนดการที่ได้รับยังคงบอกความล่าช้าได้อย่างซื่อสัตย์ในช่วงท้ายโครงการ ที่ดัชนีทั่วไปมักบิดเบือน","Earned schedule keeps flagging slippage honestly late in a project, where the ordinary index tends to mislead."),
            T("การสั่งซื้อเพื่อโครงการทำผ่านหน้าร้านที่แสดงเฉพาะรายการในงบที่อนุมัติ พนักงานหน้างานจึงสั่งนอกงบไม่ได้","Project buying goes through a shop that shows only approved budget lines, so site staff cannot order off-budget."),
        ],
        "routes":["/projects/portfolio","/projects/action-center","/projects/{code}","/projects/resources","/shop/project/{code}"]})

    # 21 — Real Estate & Construction
    S.append({"t":"mod_over","accent":"gold","glyph":"⌂","tag":T("อุตสาหกรรมเฉพาะ","VERTICAL"),
        "family":T("อสังหาริมทรัพย์และงานก่อสร้าง","Real Estate & Construction"),
        "title":T("ตั้งแต่การประมูลถึงการโอนกรรมสิทธิ์ พร้อมภาษีก่อสร้างไทยที่ถูกต้อง","From tender to title transfer, with correct Thai construction tax"),
        "positioning":T("โซลูชันเฉพาะสำหรับผู้รับเหมาและผู้พัฒนาอสังหาริมทรัพย์ บนแกนการบริหารโครงการ การจัดซื้อ และการเงิน ครอบคลุมการประมูลก่อนได้งาน การเรียกเก็บตามงวดงานพร้อมเงินประกันผลงาน การบริหารผู้รับเหมาช่วง และงานขายอสังหาริมทรัพย์ตั้งแต่การจอง สัญญาขาย การผ่อนชำระ จนถึงการโอนกรรมสิทธิ์ โดยรับรู้รายได้อย่างถูกต้อง",
                        "A purpose-built solution for contractors and property developers on the project, procurement and finance spine, covering pre-award tendering, progress billing with retention, subcontractor management, and property sales from booking through the sale contract and instalments to title transfer, with correct revenue recognition."),
        "features":[
            (T("ยูนิตและสถานะการขาย","Units & availability"),
             T("บริหารยูนิตพร้อมสถานะตั้งแต่ว่าง จอง ทำสัญญา จนถึงโอน โดยยูนิตหนึ่งขายซ้ำไม่ได้","Manage units with a status from available to reserved, contracted and transferred, where a unit cannot be double-sold.")),
            (T("การประมูลและการได้งาน","Tendering & award"),
             T("จัดทำราคาประมูลพร้อมกำไรส่วนเพิ่ม ติดตามสถานะ และเมื่อชนะจะสร้างโครงการและบัญชีปริมาณงานร่างในคลิกเดียว","Build a priced bid with markup, track its status, and on winning spin up a project and draft bill of quantities in one click.")),
            (T("การเรียกเก็บตามงวดงาน","Progress billing"),
             T("ประเมินงานตามรายการแบบสะสม เรียกเก็บเฉพาะส่วนที่เพิ่มขึ้น พร้อมภาษีขายและการหักเงินประกันผลงาน","Value work by line, cumulatively, billing only the movement, with output VAT and retention withheld.")),
            (T("การบริหารผู้รับเหมาช่วง","Subcontractor management"),
             T("บันทึกภาระผูกพันต่อบัญชีปริมาณงาน รับรองงานเป็นงวด และหักเงินประกันและภาษีหัก ณ ที่จ่ายก่อสร้าง","Register commitments against the bill of quantities, certify work in valuations, and withhold retention and construction withholding tax.")),
            (T("สัญญาขายและการอนุมัติ","Sale contracts & approval"),
             T("สัญญาที่เป็นฉบับร่างจะยังไม่บันทึกบัญชีจนกว่าผู้อนุมัติอิสระจะรับรอง ซึ่งจะเปลี่ยนสถานะยูนิตและบันทึกเงินดาวน์","A draft contract posts nothing until an independent approver certifies it, which flips the unit status and books the deposit.")),
            (T("การผ่อนชำระและการโอนกรรมสิทธิ์","Instalments & title transfer"),
             T("รับชำระงวดที่ถูกต้องเพียงครั้งเดียว และรับรู้รายได้เมื่อโอนกรรมสิทธิ์หลังชำระครบ","Receive each instalment exactly once, and recognise revenue on title transfer after full settlement.")),
        ]})
    S.append({"t":"mod_ctrl","accent":"gold",
        "family":T("อสังหาริมทรัพย์และงานก่อสร้าง","Real Estate & Construction"),
        "title":T("ภาษีก่อสร้างไทยถูกต้องตลอดสาย","Correct Thai construction tax, end to end"),
        "controls":[
            T("RE-02 — สัญญาขายต้องได้รับการรับรองจากผู้อนุมัติอิสระที่ไม่ใช่ผู้จัดทำ",
              "RE-02 — A sale contract must be certified by an independent approver other than its preparer."),
            T("PROJ-16 — การรับรองงวดงานทำโดยผู้รับรองที่แยกจากผู้ตั้งเบิก",
              "PROJ-16 — Progress claims are certified by a certifier separate from the person who raised them."),
            T("PROJ-17 — การรับรองงานผู้รับเหมาช่วงทำโดยผู้รับรองอิสระ",
              "PROJ-17 — Subcontractor valuations are certified by an independent certifier."),
            T("RE-01 — ความถูกต้องของยูนิตถูกตรวจซ้ำเมื่ออนุมัติสัญญา ยูนิตหนึ่งจึงขายซ้ำไม่ได้",
              "RE-01 — Unit integrity is re-checked at contract approval, so a unit cannot be double-sold."),
        ],
        "wow":[
            T("ราคาที่ชนะประมูลกลายเป็นงบประมาณโครงการในคลิกเดียว การประมูลและการส่งมอบจึงใช้เส้นฐานเดียวกัน","A winning bid becomes the project budget in one click, so bidding and delivery share one baseline."),
            T("ภาษีก่อสร้างไทยถูกต้องตลอดสาย ทั้งภาษีขายในงวดงาน ภาษีซื้อและภาษีหัก ณ ที่จ่ายในงานผู้รับเหมาช่วง และเงินประกันผลงาน","Correct Thai construction tax throughout — output VAT on progress claims, input and withholding tax on subcontracts, and retention."),
            T("การเรียกเก็บงวดงานเรียกเก็บเกินไม่ได้ ประเมินตามรายการแบบสะสม จำกัดที่ร้อยละร้อย และมีผู้รับรองอิสระ","Progress billing cannot over-certify: cumulative line valuation, capped at one hundred percent, with an independent certifier."),
            T("ยูนิตขายซ้ำไม่ได้ เงินอยู่ในหนี้สินตามสัญญา และไม่รับรู้รายได้จนกว่าจะโอนกรรมสิทธิ์","A unit cannot be double-sold; cash sits in a contract liability, and no revenue is recognised until title transfers."),
        ],
        "routes":["/projects/tenders","/projects/billing","/projects/subcontracts","/realestate"]})

    # 22 — Budget / Planning / Demand
    S.append({"t":"mod_over","accent":"cyan","glyph":"◑","tag":None,
        "family":T("การวางแผนและการพยากรณ์","Planning, Budgeting & Demand"),
        "title":T("งบประมาณที่บังคับใช้ได้ และการพยากรณ์ที่อธิบายเหตุผลได้","Budgets you can enforce and forecasts you can explain"),
        "positioning":T("ชั้นการวางแผนทางการเงินที่ครบถ้วน ทั้งงบประมาณแบบผู้ทำและผู้อนุมัติ แผนที่ขับเคลื่อนด้วยตัวแปร การวิเคราะห์ความผันแปรสามทาง ด่านควบคุมงบที่บังคับใช้บนการจัดซื้อ การพยากรณ์อุปสงค์ที่อธิบายได้ และการปันส่วนความสามารถในการทำกำไรตามส่วนงาน โดยความผันแปรเป็นการควบคุมเชิงตรวจจับเหนือบัญชีที่บันทึกแล้ว",
                        "A full financial-planning layer — maker-checker budgets, driver-based plans, three-way variance analysis, a budgetary-control gate enforced on procurement, explainable demand forecasting and segment-profitability allocation — where variance is a detective control over the posted ledger."),
        "features":[
            (T("งบประมาณ","Budgets"),
             T("จัดทำงบประมาณตามบัญชี งวด และศูนย์ต้นทุน โดยงบที่ยังไม่อนุมัติจะไม่ถูกนำมาเทียบกับผลจริง","Build budgets by account, period and cost centre, where an unapproved budget is excluded from variance.")),
            (T("การเทียบงบกับผลจริง","Budget versus actual"),
             T("ใช้ผลจริงจากรายการที่บันทึกแล้วเท่านั้น พร้อมทำเครื่องหมายความผันแปรที่มีสาระสำคัญและการลงนามทบทวน","Use actuals from posted entries only, flagging material variances with a management review sign-off.")),
            (T("การควบคุมงบประมาณ","Budgetary control"),
             T("กำหนดนโยบายที่ตรวจสอบความพอเพียงของงบเมื่ออนุมัติคำขอซื้อ โดยการเกินงบต้องมีเหตุผลและการอนุมัติจากผู้บริหาร","Set a policy that checks budget availability at requisition approval, where exceeding it requires a reason and executive approval.")),
            (T("แผนที่ขับเคลื่อนด้วยตัวแปร","Driver-based plans"),
             T("จัดทำแผนหลายฉบับและสถานการณ์ พร้อมพยากรณ์ที่คำนวณจากผลจริงในบัญชี","Maintain plan versions and scenarios, with forecasts computed from ledger actuals.")),
            (T("การพยากรณ์อุปสงค์","Demand forecasting"),
             T("ใช้แบบจำลองทางสถิติที่อธิบายได้หลายแบบ รวมถึงปฏิทินวันหยุดไทยและสภาพอากาศ โดยเลือกแบบที่แม่นที่สุดจากการทดสอบย้อนหลัง","Use several explainable statistical models, including the Thai holiday calendar and weather, selecting the most accurate by back-testing.")),
            (T("การปันส่วนความสามารถในการทำกำไร","Profitability allocation"),
             T("กำหนดส่วนงานและกฎการปันส่วน แล้วรายงานความสามารถในการทำกำไรตามส่วนงาน","Define segments and allocation rules, then report profitability by segment.")),
        ]})
    S.append({"t":"mod_ctrl","accent":"cyan",
        "family":T("การวางแผนและการพยากรณ์","Planning, Budgeting & Demand"),
        "title":T("งบที่บังคับใช้ได้จริง ไม่ใช่เพียงรายงาน","Budgets that are actually enforced, not merely reported"),
        "controls":[
            T("BUD-01 — งบประมาณต้องมีผู้จัดทำและผู้อนุมัติคนละคน และงบที่ยังไม่อนุมัติจะไม่ถูกนำมาเทียบผล",
              "BUD-01 — Budgets require a distinct preparer and approver, and an unapproved budget is excluded from variance."),
            T("BUD-02 — ด่านควบคุมงบจะระงับคำขอซื้อที่เกินงบ โดยการยกเว้นต้องมาจากผู้บริหารพร้อมเหตุผล",
              "BUD-02 — The budget gate blocks over-budget requisitions, where an override comes from an executive with a reason."),
            T("ELC-06 — ความผันแปรที่มีสาระสำคัญต้องมีการลงนามทบทวนพร้อมบันทึกติดตาม",
              "ELC-06 — Material variances require a review sign-off with a retained follow-up note."),
            T("EPM-04 — ผลจริงที่ใช้ในการวิเคราะห์มาจากบัญชีที่บันทึกแล้วเท่านั้น",
              "EPM-04 — Actuals used in analysis come from the posted ledger only."),
        ],
        "wow":[
            T("เปลี่ยนนโยบายจากการรายงานเป็นการบังคับใช้ แล้วคำขอซื้อที่เกินงบจะถูกหยุดที่ขั้นอนุมัติ พร้อมต้องการการยกเว้นจากผู้บริหาร","Switch the policy from reporting to enforcement, and over-budget requisitions are stopped at approval, requiring an executive override."),
            T("งบที่เอื้อประโยชน์ตนเองซ่อนการใช้จ่ายเกินไม่ได้ เพราะงบที่ยังไม่อนุมัติไม่ถูกนำมาเทียบ และอนุมัติตนเองไม่ได้","A self-serving budget cannot hide overspend, because an unapproved budget is excluded and self-approval is impossible."),
            T("การพยากรณ์อุปสงค์ใช้สถิติที่โปร่งใสและอธิบายได้ รวมถึงวันหยุดไทยและสภาพอากาศ ไม่ใช่กล่องดำ","Demand forecasting uses transparent, explainable statistics — including Thai holidays and weather — not a black box."),
            T("การทบทวนความผันแปรถูกเก็บเป็นหลักฐาน ความผันแปรที่มีสาระสำคัญต้องมีบันทึกติดตามที่ลงนาม","Variance review is retained as evidence: material variances require a signed follow-up note."),
        ],
        "routes":["/budget","/demand","/planning","/profitability"]})

    # 23 — BI & Analytics
    S.append({"t":"mod_over","accent":"violet","glyph":"◐","tag":None,
        "family":T("การวิเคราะห์และรายงาน","Business Intelligence & Analytics"),
        "title":T("ตัวชี้วัดทุกตัวเจาะลงถึงรายการในบัญชีแยกประเภท","Every metric drills down to the ledger"),
        "positioning":T("ชั้นการวิเคราะห์ที่กำกับได้ ซึ่งแปลงบัญชีแยกประเภทและรายการขายเป็นตัวชี้วัด รายงาน และการพยากรณ์ โดยทุกตัวเลขกระทบยอดกับต้นทาง จัดเก็บแคชต่อกิจการเพื่อความเร็ว และให้บริการตนเอง จัดกำหนดการ หรือสตรีมแบบเรียลไทม์ได้ ตั้งแต่กระดานตัวชี้วัดบรรทัดเดียวจนถึงศูนย์บัญชาการทางการเงินและเครื่องมือสร้างรายงานแบบไม่ต้องเขียนโค้ด",
                        "A governed analytics layer that turns the ledger and sales into metrics, reports and forecasts, where every figure reconciles to its source, is cached per company for speed, and can be self-served, scheduled or streamed in real time — from a one-line KPI board to a finance command centre and a no-code query builder."),
        "features":[
            (T("กระดานตัวชี้วัดและคิวบ์","KPI boards & cubes"),
             T("แสดงยอดขาย ลูกหนี้-เจ้าหนี้คงค้าง และไปป์ไลน์ พร้อมคิวบ์ยอดขายที่เจาะลงรายละเอียดได้","Show sales, open receivables and payables and pipeline, with a sales cube you can drill into.")),
            (T("ศูนย์บัญชาการทางการเงิน","Finance command centre"),
             T("รวมตัวชี้วัดทางการเงินหลายสิบตัวพร้อมการจัดระดับและการเทียบ โดยตัวชี้วัดที่ผิดปกติเจาะลงถึงรายการในบัญชีได้","Bring together dozens of finance metrics with rating and comparatives, where a red metric drills to its ledger rows.")),
            (T("การสอบถามและการวิเคราะห์ด้วยภาษาธรรมชาติ","Query & natural language"),
             T("ใช้ชั้นความหมายที่กำหนดไว้ล่วงหน้า อินพุตของผู้ใช้จึงไม่ถึงคำสั่งฐานข้อมูล และถามเป็นภาษาไทยหรืออังกฤษได้","Use a predefined semantic layer, so user input never reaches raw database commands, and ask in Thai or English.")),
            (T("รายงานตามกำหนดการ","Scheduled reports"),
             T("สมัครรับรายงานตามความถี่และช่องทางที่ต้องการ โดยระบบสร้างและส่งพร้อมบันทึกทุกรอบการทำงาน","Subscribe to reports by frequency and channel, with the system generating, delivering and logging every run.")),
            (T("แดชบอร์ดสดแบบสตรีมมิง","Live streaming dashboards"),
             T("อัปเดตตัวชี้วัดแบบเรียลไทม์พร้อมสถานะการเชื่อมต่อ และถอยไปใช้การดึงข้อมูลเป็นระยะเมื่อจำเป็น","Update metrics in real time with a connection indicator, falling back to polling when needed.")),
            (T("ข้อมูลเชิงลึกและการพยากรณ์","Insights & forecasting"),
             T("ตรวจจับความผิดปกติ แนะนำการเติมสินค้า และวิเคราะห์วิศวกรรมเมนูสำหรับร้านอาหาร","Detect anomalies, recommend replenishment and provide menu-engineering analysis for restaurants.")),
        ]})
    S.append({"t":"mod_ctrl","accent":"violet",
        "family":T("การวิเคราะห์และรายงาน","Business Intelligence & Analytics"),
        "title":T("ตัวเลขที่ทบทวนคือตัวเลขเดียวกันในทุกที่","The number you review is the number everywhere"),
        "controls":[
            T("BI-01 — รายงานทุกฉบับกระทบยอดกับต้นทาง เพื่อความครบถ้วนและถูกต้องของข้อมูลที่จัดทำ",
              "BI-01 — Every report reconciles to its source, for completeness and accuracy of information produced."),
            T("BI-04 — การพยากรณ์และผู้ช่วยปัญญาประดิษฐ์อยู่ในขอบเขตอ่านและให้คำแนะนำเท่านั้น",
              "BI-04 — Forecasting and the AI assistant are confined to a read-only, advisory boundary."),
            T("ELC-07 — ผู้บริหารทบทวนตัวชี้วัดเชิงวิเคราะห์เป็นการควบคุมระดับองค์กร",
              "ELC-07 — Management review of analytical metrics is an entity-level control."),
            T("R01 — ทุกจุดเชื่อมต่อผ่านการตรวจสอบสิทธิ์และการแยกข้อมูลตามกิจการ",
              "R01 — Every endpoint passes permission checks and per-company data isolation."),
        ],
        "wow":[
            T("ตัวชี้วัดทุกตัวเจาะลงถึงรายการในบัญชี นิยามเดียวป้อนทั้งแดชบอร์ด รายงานตามกำหนดการ และกระดานผู้บริหาร","Every metric drills to the ledger, and one definition feeds the dashboard, the scheduled pack and the executive board."),
            T("คำถามภาษาธรรมชาติแปลงเป็นการสอบถามที่กำกับไว้ ไม่ใช่คำสั่งฐานข้อมูลดิบ ข้อความอิสระจึงข้ามกิจการไม่ได้","A natural-language question resolves to a governed query, not raw database commands, so free text cannot cross companies."),
            T("การพยากรณ์อุปสงค์เลือกแบบจำลองที่ดีที่สุดเอง และเรียนรู้ผลของวันหยุดไทยและสภาพอากาศ โดยยังอธิบายได้","Demand forecasting self-selects the best model and learns the effect of Thai holidays and weather, while remaining explainable."),
            T("แดชบอร์ดสดพร้อมการถอยกลับอย่างนุ่มนวล ทั้งการสตรีมและการดึงข้อมูลเป็นระยะพร้อมสถานะการเชื่อมต่อ","Live dashboards degrade gracefully — streaming with a polling fallback and a connection indicator."),
        ],
        "routes":["/finance/command-center","/query","/nl-analytics","/insights","/scheduled-reports"]})

    # 24 — AI
    S.append({"t":"mod_over","accent":"green","glyph":"✦","tag":None,
        "family":T("ปัญญาประดิษฐ์","Artificial Intelligence"),
        "title":T("ผู้ช่วยปัญญาประดิษฐ์ที่ใช้เส้นทางเดียวกับแอป และแตะบัญชีโดยตรงไม่ได้","An AI that shares the app's code path and cannot touch the ledger directly"),
        "positioning":T("ชั้นผู้ช่วยที่ต่อตรงกับชั้นบริการเดียวกับที่แอปพลิเคชันใช้ ปัญญาประดิษฐ์จึงสืบทอดสิทธิ์และขอบเขตกิจการโดยอัตโนมัติ และทำได้เพียงอ่าน แนะนำ หรือเสนอเรื่องที่คนต้องอนุมัติ ระบบทำงานได้แม้ไม่มีคีย์บริการภายนอก และปิดบังข้อมูลส่วนบุคคลก่อนส่งออกทุกครั้ง",
                        "An assistant layer wired directly onto the same service layer the application uses, so it inherits permissions and company scope automatically and can only read, suggest or file a proposal a human must approve. It runs even without an external service key and redacts personal data before any outbound call."),
        "features":[
            (T("ผู้ช่วยและโคไพลอต","Assistant & copilot"),
             T("ตอบคำถามด้วยภาษาธรรมชาติจากข้อมูลของกิจการแบบเรียลไทม์ และตอบเฉพาะจากเอกสารของกิจการพร้อมอ้างอิงหรือปฏิเสธ","Answer in natural language from live company data, and respond only from the company's documents with citations, or decline.")),
            (T("การดำเนินการที่ต้องอนุมัติ","Approve-then-execute actions"),
             T("ปัญญาประดิษฐ์เสนอรายการบัญชีหรือใบสั่งซื้อเข้าคิว โดยผู้อื่นที่มีสิทธิ์ต้องอนุมัติก่อนจึงจะดำเนินการ","The AI proposes a journal entry or purchase order to a queue, which a different authorised person must approve before it runs.")),
            (T("การอ่านเอกสารด้วยปัญญาประดิษฐ์","Document intake"),
             T("แปลงข้อความใบแจ้งหนี้เป็นร่างตั้งหนี้ที่มีโครงสร้าง โดยคนเป็นผู้บันทึกผ่านวงจรปกติ","Turn invoice text into a structured payables draft, which a human posts through the normal cycle.")),
            (T("การปิดบังข้อมูลส่วนบุคคล","PII redaction"),
             T("ปิดบังอีเมล เบอร์โทร เลขบัตรประชาชน และที่อยู่ ก่อนส่งไปยังแบบจำลองภายนอกทุกครั้ง","Mask email, phone, citizen ID and address before anything reaches an external model.")),
            (T("การกำหนดค่าและการวิเคราะห์ด้วยภาษา","Config & NL analytics"),
             T("อธิบายฟิลด์ กฎ หรือระบบอัตโนมัติเป็นภาษาธรรมชาติ แล้วได้ร่างการตั้งค่าให้ทบทวนก่อนใช้","Describe a field, rule or automation in plain language and receive a config draft to review before applying.")),
            (T("การกำกับค่าใช้จ่ายปัญญาประดิษฐ์","AI spend governance"),
             T("กำหนดเพดานการใช้งานต่อกิจการ และติดตามค่าใช้จ่ายข้ามกิจการจากศูนย์ควบคุมแพลตฟอร์ม","Set usage caps per company and track cross-company spend from the platform console.")),
        ]})
    S.append({"t":"mod_ctrl","accent":"green",
        "family":T("ปัญญาประดิษฐ์","Artificial Intelligence"),
        "title":T("ปัญญาประดิษฐ์เห็นและทำได้เท่าที่ผู้ใช้ทำได้","The AI sees and does only what the user can"),
        "controls":[
            T("BI-04 — ปัญญาประดิษฐ์อยู่ในขอบเขตอ่านและให้คำแนะนำ ไม่บันทึกบัญชีโดยตรง",
              "BI-04 — The AI is confined to a read-only, advisory boundary and does not post to the ledger directly."),
            T("SoD — การดำเนินการที่ปัญญาประดิษฐ์เสนอต้องได้รับอนุมัติจากบุคคลอื่น",
              "SoD — Actions the AI proposes must be approved by a different person."),
            T("AIG-01 ถึง AIG-04 — มีการทดสอบความถูกต้องอัตโนมัติ ด่านคุ้มครองข้อมูล และการติดฉลากอย่างซื่อสัตย์",
              "AIG-01 to AIG-04 — Automated accuracy tests, a data-protection gate and honest labelling are in place."),
            T("PDPA — ปิดบังข้อมูลส่วนบุคคลก่อนส่งออก และให้กิจการเลือกไม่เข้าร่วมได้",
              "PDPA — Personal data is redacted before egress, and a company can opt out."),
        ],
        "wow":[
            T("ปัญญาประดิษฐ์ใช้เส้นทางเดียวกับแอป ไม่มีช่องทางแยกที่ไม่ผ่านการตรวจสอบสิทธิ์ จึงเห็นและทำได้เท่าที่ผู้ใช้ทำได้","The AI shares the app's code path with no separate un-authorised surface, so it sees and does only what the user can."),
            T("เสนอ อนุมัติ แล้วดำเนินการ ด้วยกำแพงแยกหน้าที่ที่แข็งแรง แบบจำลองร่างรายการได้ แต่คนอื่นที่มีสิทธิ์ต้องอนุมัติ","Propose, approve, then execute, behind a firm segregation wall: the model can draft, but a different authorised person must approve."),
            T("ตอบเฉพาะจากเอกสารของกิจการพร้อมอ้างอิง หรือปฏิเสธ ไม่กุนโยบายขึ้นเอง","It answers only from the company's documents with citations, or declines — it does not fabricate policy."),
            T("ทำงานได้แม้ไม่มีการเชื่อมต่อภายนอก พร้อมการทดสอบความถูกต้องอัตโนมัติและการปิดบังข้อมูลก่อนส่งออก","It runs even offline, with automated accuracy testing and data redaction before egress."),
        ],
        "routes":["/assistant","/copilot","/ai-actions","/doc-ai","/nl-analytics"]})

    # 25 — Studio / No-code
    S.append({"t":"mod_over","accent":"gold","glyph":"◭","tag":None,
        "family":T("การปรับแต่งแบบไม่ต้องเขียนโค้ด","No-Code Customisation Studio"),
        "title":T("ปรับระบบให้เข้ากับธุรกิจได้เอง โดยไม่ต้องเขียนโค้ด","Shape the system to your business without writing code"),
        "positioning":T("ชุดเครื่องมือปรับแต่งแบบไม่ต้องเขียนโค้ดที่ให้แต่ละกิจการปรับระบบให้เข้ากับธุรกิจได้โดยไม่ต้องมีนักพัฒนา ครอบคลุมฟิลด์และวัตถุที่กำหนดเอง ผังฟอร์ม เครื่องมือสร้างขั้นตอนการอนุมัติ การแจ้งเตือน และระบบอัตโนมัติ แม่แบบเอกสาร ธีมแบรนด์ และการควบคุมเมนู โดยทุกอย่างแยกข้อมูลตามกิจการและไม่กระทบบัญชีแยกประเภท",
                        "A no-code toolkit that lets each company adapt the system to its business without a developer, covering custom fields and objects, form layouts, approval, alert and automation builders, document templates, brand themes and menu control — all isolated by company and posting nothing to the ledger."),
        "features":[
            (T("ฟิลด์และวัตถุที่กำหนดเอง","Custom fields & objects"),
             T("เพิ่มฟิลด์ที่มีชนิดข้อมูลชัดเจนบนทุกรายการ และสร้างชนิดระเบียนใหม่ได้โดยไม่ต้องมีโมดูลสำเร็จรูป","Add typed fields to any entity and create new record types without a shipped module.")),
            (T("ผังฟอร์มและมุมมอง","Form layouts & views"),
             T("จัดวางส่วนและคอลัมน์ตามบทบาท โดยอ้างอิงฟิลด์จริง ฟิลด์ใหม่จึงปรากฏเองและการอ้างอิงที่ล้าสมัยจะถูกตัดออก","Arrange sections and columns by role against live fields, so new fields appear automatically and stale references drop.")),
            (T("การอนุมัติ การแจ้งเตือน และระบบอัตโนมัติ","Approvals, alerts & automation"),
             T("สร้างขั้นตอนการอนุมัติหลายชั้น กฎการแจ้งเตือน และกฎอัตโนมัติแบบเมื่อเกิดเหตุแล้วดำเนินการ โดยไม่กระทบบัญชี","Build multi-level approvals, alert rules and when-then automations, none of which touch the ledger.")),
            (T("แม่แบบเอกสาร","Document templates"),
             T("ออกแบบใบเสร็จ ใบเสนอราคา ใบสั่งซื้อ และใบกำกับภาษี โดยไม่สามารถเปลี่ยนยอดหรือลบฟิลด์ที่กฎหมายกำหนด","Design receipts, quotes, purchase orders and tax invoices, without altering amounts or removing mandatory fields.")),
            (T("ธีมแบรนด์และการควบคุมเมนู","Brand theme & menu control"),
             T("ปรับสีและโลโก้ทั้งระบบ และซ่อนหรือปิดโมดูลต่อกิจการ โดยไม่กระทบกิจการอื่น","Adjust colours and logo across the app, and hide or disable modules per company without affecting others.")),
            (T("ผู้ช่วยกำหนดค่า","Configuration assistant"),
             T("อธิบายการตั้งค่าที่ต้องการเป็นภาษาธรรมชาติ แล้วได้ร่างการตั้งค่าที่พร้อมนำไปใช้หลังการทบทวน","Describe the configuration you want in plain language and receive a ready-to-apply draft after review.")),
        ]})
    S.append({"t":"mod_ctrl","accent":"gold",
        "family":T("การปรับแต่งแบบไม่ต้องเขียนโค้ด","No-Code Customisation Studio"),
        "title":T("ปรับแต่งได้อิสระ แต่ปลอดภัยต่อการตรวจสอบโดยการออกแบบ","Freely customisable, yet auditor-safe by design"),
        "controls":[
            T("ITGC-AC-03 — ทุกการปรับแต่งแยกข้อมูลตามกิจการด้วยการรักษาความปลอดภัยระดับแถว",
              "ITGC-AC-03 — Every customisation is isolated by company through row-level security."),
            T("ITGC-AC-10 — ทุกการเปลี่ยนแปลงถูกบันทึกในร่องรอยการตรวจสอบแบบเพิ่มได้อย่างเดียว",
              "ITGC-AC-10 — Every change is recorded in an append-only audit trail."),
            T("MDM-02 — การนำเข้าจำนวนมากผ่านการตรวจสอบความถูกต้อง",
              "MDM-02 — Bulk imports pass validation."),
            T("การออกแบบ — ทุกฟีเจอร์ปรับแต่งไม่กระทบบัญชีแยกประเภทและใช้สิทธิ์น้อยที่สุด",
              "By design — no customisation feature affects the ledger, and least privilege applies."),
        ],
        "wow":[
            T("สร้างแอปพลิเคชันของตนเองได้ทั้งชุดโดยไม่ต้องเขียนโค้ด ทั้งการนิยามวัตถุ ฟิลด์ ผังฟอร์มตามบทบาท และการเก็บข้อมูล","Build an entire application of your own without code — define the object, its fields, a role-based layout and capture records."),
            T("แม่แบบเอกสารปลอดภัยต่อการตรวจสอบโดยการออกแบบ ปรับรูปแบบใบกำกับภาษีได้ แต่ฟิลด์ที่กฎหมายกำหนดถูกคงไว้และยอดแก้ไม่ได้","Document templates are auditor-safe by design: restyle a tax invoice, yet mandatory fields are retained and amounts cannot change."),
            T("ปรับเมนูและโมดูลได้ต่อกิจการ ทั้งการซ่อน จัดลำดับ และปิด โดยไม่กระทบกิจการอื่น","Tailor menus and modules per company — hide, reorder and disable — without affecting other companies."),
            T("ปัญญาประดิษฐ์ช่วยร่างการตั้งค่าได้ อธิบายเป็นภาษาธรรมชาติแล้วได้ร่างที่พร้อมนำไปใช้","The AI can draft configuration: describe it in plain language and receive a ready-to-apply proposal."),
        ],
        "routes":["/custom-fields","/custom-objects","/object-layouts","/workflow","/automation","/document-templates"]})

    # 26 — Platform, Integrations & Portal (single card grid)
    S.append({"t":"cards","accent":"teal","cols":3,
        "section":T("เจาะลึกแต่ละโมดูล","Module deep dive"),
        "kicker":T("แพลตฟอร์มและระบบนิเวศ","Platform & Ecosystem"),
        "title":T("การบริหารหลายกิจการ การเชื่อมต่อ และพอร์ทัลลูกค้า","Multi-company operations, integrations and a customer portal"),
        "intro":T("ระบบควบคุมแบบบริการหลายกิจการ พร้อมชุดเชื่อมต่อและพอร์ทัลลูกค้า โดยการจัดตั้งกิจการสงวนไว้สำหรับผู้ดูแลแพลตฟอร์ม และทุกส่วนแยกข้อมูลตามกิจการ",
                  "A multi-company control plane with an integration suite and a customer portal, where provisioning is reserved for the platform owner and every part is isolated by company."),
        "cards":[
            (T("ศูนย์ควบคุมแพลตฟอร์ม","Platform console"),
             T("จัดตั้ง ระงับ และเข้าดูแทนกิจการ พร้อมตัวชี้วัดธุรกิจข้ามกิจการและร่องรอยการตรวจสอบที่พิสูจน์ได้","Provision, suspend and act on behalf of a company, with cross-company business metrics and a verifiable audit trail."),"teal"),
            (T("การจัดตั้งแบบครบในขั้นตอนเดียว","Atomic provisioning"),
             T("สร้างกิจการ ผู้ดูแล ช่วงทดลอง งวดบัญชี และผังบัญชีตามอุตสาหกรรมในธุรกรรมเดียว พร้อมบันทึกได้ทันที","Create the company, administrator, trial, fiscal periods and industry chart of accounts in one transaction, ready to post immediately."),"teal"),
            (T("การเข้าดูแทนแบบอ่านอย่างเดียว","Read-only impersonation"),
             T("ผู้ดูแลแพลตฟอร์มตรวจสอบกิจการใดก็ได้โดยห้ามการแก้ไข และทุกการกระทำถูกบันทึกไว้","The platform owner can inspect any company with mutations blocked, and every action is logged."),"cyan"),
            (T("เอพีไอสาธารณะและพอร์ทัลนักพัฒนา","Public API & developer portal"),
             T("เปิดเอพีไอที่จำกัดขอบเขตและอัตราการเรียก แยกข้อมูลตามกิจการ พร้อมเอกสารมาตรฐานอัตโนมัติ","Expose a scope-gated, rate-limited API isolated by company, with auto-generated standard documentation."),"violet"),
            (T("เว็บฮุก การยืนยันตัวตน และการเชื่อมต่อ","Webhooks, SSO & connectors"),
             T("ส่งเว็บฮุกที่ลงลายมือชื่อ รองรับการยืนยันตัวตนองค์กร และชุดเชื่อมต่อที่พักข้อมูลไว้ให้ตรวจสอบก่อนบันทึก","Deliver signed webhooks, support enterprise sign-on, and stage connector data for review before posting."),"violet"),
            (T("พอร์ทัลลูกค้า","Customer portal"),
             T("มอบแดชบอร์ด การขาย สต๊อกพร้อมการสั่งซื้ออัตโนมัติ การติดตามคำสั่งซื้อ และคะแนนสะสม แยกจากส่วนหลังบ้านอย่างชัดเจน","Give a dashboard, sales, stock with auto-reorder, order tracking and loyalty, cleanly separated from the back office."),"gold"),
        ]})
    return S


# ══════════════════════════════════════════════════════════════════════════════
# FULL DECK ASSEMBLY
# ══════════════════════════════════════════════════════════════════════════════
def build_specs():
    S = []

    # ── Cover ────────────────────────────────────────────────────────────────
    S.append({"t":"cover",
        "kicker":T("แพลตฟอร์มบริหารธุรกิจสำหรับองค์กร","Enterprise Business Platform"),
        "title":"Invisible ERP",
        "subtitle":T("ระบบบริหารธุรกิจที่รวมงานหลังบ้าน หน้าร้าน ลูกค้าสัมพันธ์ และสมาชิกไว้ในแพลตฟอร์มเดียว ออกแบบบนหลักการควบคุมภายในระดับบริษัทมหาชน",
                     "One platform that unites back office, point of sale, customer relationships and loyalty — engineered on public-company internal-control principles."),
        "tagline":T("ควบคุมรัดกุม โปร่งใส รองรับกฎหมายไทยเต็มรูปแบบ และพร้อมมาตรฐานสากล",
                    "Rigorously controlled, transparent, fully Thai-compliant and ready for international standards."),
        "credit":T("พัฒนาโดย","Developed by")})

    # ── Agenda ───────────────────────────────────────────────────────────────
    S.append({"t":"agenda",
        "kicker":T("สารบัญ","Contents"),
        "title":T("ภาพรวมของการนำเสนอ","What this presentation covers"),
        "items":[
            ("0", T("ภาพรวมระบบ","Overview"), T("สรุปภาพรวมและคุณค่าทางธุรกิจ","The platform and its business value")),
            ("1", T("จุดที่เหนือกว่า","Where we lead"), T("ข้อได้เปรียบที่คู่แข่งลอกได้ยาก","Advantages competitors cannot easily copy")),
            ("2", T("ความปลอดภัยและการควบคุม","Security & control"), T("ความปลอดภัยและการควบคุมภายใน","Security and internal control")),
            ("3", T("โมดูลในระบบขายหน้าร้าน","Point-of-sale modules"), T("ขอบเขตงานฝั่งหน้าร้านทั้งหมด","The full front-of-house footprint")),
            ("4", T("โมดูลในระบบหลังบ้าน","ERP modules"), T("ขอบเขตงานฝั่งหลังบ้านทั้งหมด","The full back-office footprint")),
            ("5", T("เจาะลึกแต่ละโมดูล","Module deep dive"), T("รายละเอียดเชิงลึกของแต่ละโมดูล","Each module in depth")),
            ("6", T("ข้อควรพิจารณาเพิ่มเติม","Further considerations"), T("การนำไปใช้ การรองรับ และก้าวต่อไป","Adoption, support and next steps")),
        ]})

    # ══ SECTION 0 — OVERVIEW ════════════════════════════════════════════════
    S.append({"t":"divider","num":"0","accent":"teal","label":T("ส่วนที่","SECTION"),
        "title":T("ภาพรวมระบบ","Overview"),
        "subtitle":T("Invisible ERP คืออะไร และสร้างคุณค่าให้ธุรกิจของท่านอย่างไร",
                     "What Invisible ERP is, and the value it creates for your business.")})

    S.append({"t":"bullets","accent":"teal","section":T("ภาพรวมระบบ","Overview"),
        "kicker":T("ภาพรวม · 0.1","Overview · 0.1"),
        "title":T("Invisible ERP คืออะไร","What Invisible ERP is"),
        "intro":T("ระบบบริหารธุรกิจที่รวมงานหลังบ้าน หน้าร้าน ลูกค้าสัมพันธ์ และสมาชิกไว้บนสถาปัตยกรรมเดียว ผู้ใช้ทำงานได้อย่างราบรื่น ในขณะที่เบื้องหลังมีการควบคุมระดับบริษัทมหาชนกำกับอยู่ทุกขั้นตอน",
                  "A business platform that unites the back office, point of sale, customer relationships and loyalty on a single architecture — smooth for the people who use it, while public-company controls govern every step behind the scenes."),
        "bullets":[
            (T("แพลตฟอร์มเดียวครอบคลุมทุกวงจร","One platform, every cycle"),
             T("ตั้งแต่การขายหน้าร้าน คลังสินค้า การจัดซื้อ การผลิต จนถึงบัญชี การปิดงบ และภาษี โดยไม่ต้องเชื่อมต่อหลายระบบ","from point of sale to inventory, procurement, production, accounting, close and tax — without stitching systems together.")),
            (T("รองรับกฎหมายไทยอย่างแท้จริง","Genuinely built for Thailand"),
             T("ภาษีมูลค่าเพิ่มและภาษีหัก ณ ที่จ่าย ใบกำกับภาษีตามกฎหมาย ใบกำกับภาษีอิเล็กทรอนิกส์ พร้อมเพย์ และ LINE โดยใช้เวลามาตรฐานของไทย","VAT and withholding tax, statutory and electronic tax invoices, PromptPay and LINE, on Thai business time.")),
            (T("แยกข้อมูลถึงระดับฐานข้อมูล","Isolation at the database layer"),
             T("ข้อมูลของแต่ละกิจการถูกแยกขาดจากกันด้วยการรักษาความปลอดภัยระดับแถวของฐานข้อมูล ไม่ใช่เพียงระดับแอปพลิเคชัน","each company's data is separated by database row-level security, not merely by application code.")),
            (T("ควบคุมภายในระดับบริษัทมหาชน","Public-company internal control"),
             T("มาตรการควบคุมหลายร้อยรายการ การอนุมัติแบบผู้ทำและผู้อนุมัติที่บังคับใช้แม้กับผู้ดูแลระบบ และร่องรอยการตรวจสอบที่แก้ไขไม่ได้","hundreds of controls, maker-checker enforced even against the administrator, and an immutable audit trail.")),
            (T("ปรับแต่งได้เองและมีปัญญาประดิษฐ์ในตัว","Customisable, with AI built in"),
             T("ปรับแต่งได้โดยไม่ต้องเขียนโค้ด และมีผู้ช่วยปัญญาประดิษฐ์ที่สืบทอดสิทธิ์และถูกกั้นจากบัญชีแยกประเภท","no-code customisation and an AI assistant that inherits permissions and is fenced from the ledger.")),
        ]})

    S.append({"t":"stats","accent":"teal","section":T("ภาพรวมระบบ","Overview"),
        "kicker":T("ภาพรวม · 0.2","Overview · 0.2"),
        "title":T("Invisible ERP ในเชิงตัวเลข","Invisible ERP by the numbers"),
        "intro":T("ขนาดและความลึกของระบบสะท้อนความพร้อมในระดับองค์กร","The platform's scale and depth reflect enterprise readiness."),
        "stats":[
            ("100+", T("โมดูลธุรกิจ","business modules"), T("ครอบคลุมทุกวงจรงานในระบบเดียว","covering every cycle in one system")),
            ("282", T("มาตรการควบคุม","documented controls"), T("บันทึกไว้ครบ ไม่มีช่องว่างที่ยังเปิดอยู่","fully documented, with no open gap")),
            ("23", T("กฎการแยกหน้าที่","segregation-of-duties rules"), T("ประเมินอัตโนมัติจากสิทธิ์จริงของผู้ใช้","evaluated automatically from real permissions")),
            ("110+", T("ชุดทดสอบการควบคุม","control test suites"), T("ตรวจพิสูจน์การควบคุมทุกครั้งที่ปรับปรุงระบบ","re-proving the controls on every release")),
        ],
        "footer":T("ตัวเลขทั้งหมดสร้างจากซอร์สโค้ดจริง และมีกลไกตรวจสอบที่ห้ามการกล่าวอ้างเกินจริง จึงเป็นตัวเลขที่พิสูจน์ได้",
                   "Every figure is generated from the codebase, with a guard that forbids overstatement — so the numbers are verifiable.")})

    S.append({"t":"cards","accent":"teal","section":T("ภาพรวมระบบ","Overview"),"cols":2,
        "kicker":T("ภาพรวม · 0.3","Overview · 0.3"),
        "title":T("หนึ่งแพลตฟอร์ม สี่ส่วนงานที่ทำงานร่วมกัน","One platform, four surfaces working as one"),
        "intro":T("ทั้งสี่ส่วนใช้ข้อมูล สิทธิ์ และการควบคุมชุดเดียวกัน ธุรกรรมหน้าร้านจึงไหลเข้าสู่บัญชีและการวิเคราะห์ทันที โดยไม่ต้องซิงก์ระหว่างระบบ",
                  "All four surfaces share one set of data, permissions and controls, so front-of-house transactions flow straight into accounting and analytics, with nothing to synchronise."),
        "cards":[
            (T("หน้าร้าน","Point of sale"),T("ระบบขายและร้านอาหาร","Retail & restaurant POS"),
             T("การขายหน้าร้าน งานร้านอาหาร การทำงานออฟไลน์ และเดลิเวอรี โดยบันทึกลงบัญชีอัตโนมัติ","Retail selling, restaurant operations, offline working and delivery, posting to the ledger automatically."),"cyan"),
            (T("หลังบ้าน","Back office"),T("ระบบบริหารทรัพยากรองค์กร","The ERP core"),
             T("คลัง จัดซื้อ ผลิต บัญชี การเงิน ภาษี บุคคล โครงการ และการวางแผน อย่างครบวงจร","Inventory, procurement, production, accounting, finance, tax, people, projects and planning."),"teal"),
            (T("ลูกค้าสัมพันธ์และสมาชิก","CRM & loyalty"),T("งานขายและความสัมพันธ์","Sales & relationships"),
             T("ไปป์ไลน์ ใบเสนอราคา บริการหลังการขาย และระบบสมาชิกที่ผูกกับ LINE และบัญชีแยกประเภทจริง","Pipeline, quoting, after-sales and loyalty tied to LINE and to the general ledger."),"violet"),
            (T("พอร์ทัลลูกค้า","Customer portal"),T("บริการตนเอง","Self-service"),
             T("พอร์ทัลสำหรับลูกค้า สาขา และคู่ค้า ทั้งแดชบอร์ด การขาย สต๊อก และการติดตามคำสั่งซื้อ","A portal for customers, branches and partners — dashboard, sales, stock and order tracking."),"gold"),
        ]})

    S.append({"t":"cards","accent":"teal","section":T("ภาพรวมระบบ","Overview"),"cols":3,
        "kicker":T("ภาพรวม · 0.4","Overview · 0.4"),
        "title":T("คุณค่าทางธุรกิจที่ท่านจะได้รับ","The business value you receive"),
        "cards":[
            (T("ลดต้นทุนระบบซ้ำซ้อน","Lower system cost"),T("",""),
             T("แทนที่ระบบขาย บัญชี ลูกค้าสัมพันธ์ และคลังหลายระบบด้วยแพลตฟอร์มเดียว ลดค่าลิขสิทธิ์และค่าเชื่อมต่อ","Replace separate POS, accounting, CRM and inventory systems with one platform, cutting licence and integration costs."),"teal"),
            (T("ป้องกันการทุจริตในตัว","Fraud prevention built in"),T("",""),
             T("การอนุมัติแบบผู้ทำและผู้อนุมัติ การแยกหน้าที่ และการควบคุมการรับของ ลดความเสี่ยงการรั่วไหลของเงินและสต๊อก","Maker-checker, segregation of duties and receiving controls reduce the risk of losing cash and stock."),"coral"),
            (T("ปิดงบได้เร็วขึ้น","Close the books faster"),T("",""),
             T("ห้องควบคุมการปิดงวด การกระทบยอดอัตโนมัติ และบัญชีที่สมดุลโดยโครงสร้าง ช่วยลดจำนวนวันปิดงบ","A close cockpit, automatic reconciliation and a ledger balanced by construction shorten the close."),"gold"),
            (T("ตัดสินใจด้วยข้อมูลสด","Decide on live data"),T("",""),
             T("การวิเคราะห์ที่เจาะลงถึงบัญชี ตัวชี้วัดแบบเรียลไทม์ การพยากรณ์ และการถามด้วยภาษาไทย","Analytics that drill to the ledger, real-time metrics, forecasting and questions asked in Thai."),"violet"),
            (T("พร้อมสำหรับการตรวจสอบและระดมทุน","Ready for audit and capital"),T("",""),
             T("มาตรการควบคุมที่ครบถ้วน ความพร้อมต่อมาตรฐานสากล และร่องรอยการตรวจสอบที่แก้ไม่ได้ เพิ่มความน่าเชื่อถือ","A complete control set, readiness for international standards and an immutable audit trail build credibility."),"green"),
            (T("เติบโตได้โดยไม่ติดเพดาน","Grow without a ceiling"),T("",""),
             T("รองรับหลายสาขา หลายกิจการ หลายมาตรฐานบัญชี และหลายสกุลเงิน พร้อมเอพีไอที่เปิดกว้าง","Support many branches, companies, accounting standards and currencies, with an open API."),"cyan"),
        ]})

    # ══ SECTION 1 — WHERE WE LEAD ═══════════════════════════════════════════
    S.append({"t":"divider","num":"1","accent":"gold","label":T("ส่วนที่","SECTION"),
        "title":T("จุดที่ Invisible เหนือกว่า","Where Invisible leads"),
        "subtitle":T("ข้อได้เปรียบที่ไม่ใช่เพียงคุณสมบัติ แต่เป็นการตัดสินใจเชิงสถาปัตยกรรมที่คู่แข่งลอกได้ยาก",
                     "Advantages that are not features but architectural decisions competitors cannot easily copy.")})

    S.append({"t":"cards","accent":"gold","section":T("จุดที่เหนือกว่า","Where we lead"),"cols":3,
        "kicker":T("จุดที่เหนือกว่า · 1.1","Where we lead · 1.1"),
        "title":T("เก้าจุดที่ท่านจะไม่พบจากที่อื่น","Nine things you will not find elsewhere"),
        "cards":[
            (T("สมุดภาษีที่แก้ย้อนหลังไม่ได้","Tamper-evident fiscal journal"),T("",""),
             T("สมุดภาษีร้อยเรียงด้วยการเข้ารหัสตามข้อกำหนดสรรพากร การแก้รายการเก่าจะทำให้รายการถัดไปผิดทันที","A cryptographically chained fiscal journal to Revenue-Department standards; altering a past entry breaks every entry after it."),"cyan"),
            (T("การอนุมัติที่บังคับแม้กับผู้ดูแล","Maker-checker that binds admins"),T("",""),
             T("แม้ผู้ดูแลระบบก็อนุมัติงานของตนเองไม่ได้ในทุกจุดที่สัมผัสเงิน","Even the administrator cannot approve their own work at any point that touches cash."),"coral"),
            (T("งบประมาณที่บังคับใช้ได้จริง","Budgets you can enforce"),T("",""),
             T("ด่านควบคุมงบหยุดคำขอซื้อที่เกินงบ พร้อมการกันงบที่ปลอดภัยต่อการทำงานพร้อมกัน","A budget gate halts over-budget requisitions, with concurrency-safe reservation."),"gold"),
            (T("ปัญญาประดิษฐ์ที่ถูกกั้นจากบัญชี","AI fenced from the ledger"),T("",""),
             T("ผู้ช่วยใช้เส้นทางเดียวกับแอป สืบทอดสิทธิ์ และเสนอเรื่องให้คนอนุมัติเท่านั้น","The assistant shares the app's path, inherits permissions, and can only propose for human approval."),"green"),
            (T("หลายมาตรฐานบัญชีและมาตรฐานสากล","Multi-GAAP and IFRS"),T("",""),
             T("บัญชีแยกหลายชุด งบรวมข้ามสกุลเงิน การรับรู้รายได้ สัญญาเช่า และเครื่องมือทางการเงินครบถ้วน","Parallel ledgers, cross-currency consolidation, revenue, leases and financial instruments in full."),"violet"),
            (T("การทำงานออฟไลน์ที่ใช้ได้จริง","Offline that truly works"),T("",""),
             T("แอปขายต่อได้ทั้งการขายด่วนและการเปิดโต๊ะขณะอินเทอร์เน็ตขัดข้อง แล้วส่งข้อมูลกลับเพียงครั้งเดียว","The app keeps selling — quick sales and dine-in — through an outage, then replays exactly once."),"cyan"),
            (T("คะแนนสะสมที่ลงบัญชีจริง","Points booked as a liability"),T("",""),
             T("คะแนนเป็นภาระผูกพันในบัญชีตามมาตรฐาน พร้อมการหักกลบระหว่างกิจการในเครือข่ายพันธมิตร","Points are a booked liability under the standard, with intercompany clearing across a coalition."),"gold"),
            (T("ผูกกับ LINE ตลอดเส้นทาง","LINE-native throughout"),T("",""),
             T("สั่งซื้อ อนุมัติ รับของ งานสมาชิก และผู้ช่วย ทำผ่าน LINE ได้โดยการควบคุมไม่สูญหาย","Ordering, approvals, receiving, loyalty and assistance run over LINE with controls intact."),"green"),
            (T("การควบคุมที่ตรวจพิสูจน์ตัวเอง","Controls that test themselves"),T("",""),
             T("มาตรการควบคุมส่วนใหญ่มีการทดสอบอัตโนมัติที่ทำงานทุกครั้งที่ปรับปรุงระบบ","Most controls carry an automated test that runs on every release."),"teal"),
        ]})

    S.append({"t":"compare","accent":"gold","section":T("จุดที่เหนือกว่า","Where we lead"),
        "kicker":T("จุดที่เหนือกว่า · 1.2","Where we lead · 1.2"),
        "title":T("Invisible ERP เทียบกับระบบทั่วไป","Invisible ERP versus a typical system"),
        "us":T("Invisible ERP","Invisible ERP"),"them":T("ระบบทั่วไป","A typical system"),
        "rows":[
            (T("การแยกข้อมูลหลายกิจการ","Multi-company isolation"),
             T("ระดับฐานข้อมูล และปฏิเสธการเริ่มระบบหากตั้งค่าเสี่ยง","At the database, refusing to start if misconfigured"),
             T("ระดับแอปพลิเคชันเท่านั้น","Application code only")),
            (T("การควบคุมภายใน","Internal control"),
             T("หลายร้อยมาตรการ พร้อมการทดสอบทุกครั้งที่ปรับปรุง","Hundreds of controls, tested on every release"),
             T("เอกสารบรรยายที่ไม่เปลี่ยนแปลง","Static narrative documents")),
            (T("การอนุมัติแบบผู้ทำและผู้อนุมัติ","Maker-checker"),
             T("บังคับใช้แม้กับผู้ดูแลระบบ ทุกจุดที่สัมผัสเงิน","Enforced even against the administrator"),
             T("ผู้ดูแลอนุมัติงานของตนเองได้","Admins can approve their own work")),
            (T("ภาษีไทย","Thai tax"),
             T("ใบกำกับภาษีอิเล็กทรอนิกส์ที่ลงลายมือชื่อ และแบบภาษีครบถ้วน","Signed e-Tax invoices and complete returns"),
             T("ภาษีมูลค่าเพิ่มพื้นฐานและการส่งออกไฟล์","Basic VAT and file export")),
            (T("การรับรู้รายได้","Revenue recognition"),
             T("ตามมาตรฐานครบทั้งห้าขั้นตอน","The standard in full, all five steps"),
             T("การทยอยรับรู้แบบเส้นตรง","Straight-line deferral")),
            (T("ปัญญาประดิษฐ์","Artificial intelligence"),
             T("สืบทอดสิทธิ์ และถูกกั้นจากบัญชีแยกประเภท","Inherits permissions, fenced from the ledger"),
             T("แชตบอตที่ติดตั้งแยกภายหลัง","A bolt-on chatbot")),
            (T("การทำงานออฟไลน์","Offline operation"),
             T("ขายต่อได้และส่งข้อมูลกลับเพียงครั้งเดียว","Keeps selling and replays exactly once"),
             T("ต้องเชื่อมต่ออินเทอร์เน็ตตลอดเวลา","Requires a constant connection")),
        ]})

    S.append({"t":"bullets","accent":"gold","section":T("จุดที่เหนือกว่า","Where we lead"),"twocol":True,
        "kicker":T("จุดที่เหนือกว่า · 1.3","Where we lead · 1.3"),
        "title":T("เหตุใดข้อได้เปรียบเหล่านี้จึงลอกได้ยาก","Why these advantages are hard to copy"),
        "intro":T("จุดแตกต่างของ Invisible ไม่ใช่คุณสมบัติผิวเผิน แต่เป็นการตัดสินใจเชิงสถาปัตยกรรมที่ฝังอยู่ในระบบ คู่แข่งจึงต้องออกแบบใหม่ทั้งหมดจึงจะตามได้",
                  "Invisible's differences are not surface features but architectural decisions embedded throughout the system — matching them would require rebuilding it."),
        "bullets":[
            (T("การควบคุมเป็นค่าตั้งต้น","Control by default"),
             T("ระบบปฏิเสธที่จะเริ่มทำงานหากตั้งค่าเสี่ยงต่อการรั่วไหลของข้อมูล ความปลอดภัยจึงปิดโดยบังเอิญไม่ได้","the system refuses to start if misconfigured for a leak, so security cannot be switched off by accident.")),
            (T("การควบคุมที่พิสูจน์ตัวเอง","Self-proving controls"),
             T("การทดสอบอัตโนมัติตรวจพิสูจน์การควบคุมทุกครั้งที่ปรับปรุงระบบ ไม่ใช่การสุ่มตรวจปีละครั้ง","automated tests re-prove the controls on every release, not by an annual sample.")),
            (T("บัญชีที่สมดุลโดยโครงสร้าง","Balanced by construction"),
             T("ทุกรายการบัญชีสมดุลและไม่ซ้ำโดยการออกแบบ ข้อมูลบัญชีจึงคลาดเคลื่อนอย่างเงียบ ๆ ไม่ได้","every entry is balanced and idempotent by design, so the books cannot drift silently.")),
            (T("การตรึงตรรกะทางการเงิน","Locked financial logic"),
             T("ตรรกะทางการเงินถูกตรึงไว้ การเปลี่ยนผลลัพธ์โดยไม่ตั้งใจจะทำให้การตรวจสอบอัตโนมัติล้มเหลว","financial logic is pinned, and an unintended change fails the automated checks.")),
            (T("ความซื่อสัตย์โดยบังคับ","Honesty by enforcement"),
             T("กลไกตรวจสอบห้ามการกล่าวอ้างเกินจริง ตัวเลขที่นำเสนอจึงเชื่อถือได้","a guard forbids overstatement, so the figures presented can be trusted.")),
            (T("โลคัลไลซ์ระดับกฎหมาย","Localisation to the letter of the law"),
             T("ไม่ใช่เพียงการแปลภาษา แต่รวมถึงลายมือชื่อดิจิทัลและรูปแบบไฟล์ที่ยื่นต่อหน่วยงานได้จริง","more than translation — digital signatures and file formats that file with the authorities."),),
            (T("แกนข้อมูลเดียว","A single data spine"),
             T("ข้อมูลจากหน้าร้านไหลเข้าสู่บัญชีและการวิเคราะห์ทันที ตัวเลขที่เห็นคือตัวเลขจริงตามเวลา","front-of-house data flows into accounting and analytics at once — the numbers you see are real-time.")),
            (T("หลายมาตรฐานด้วยการบันทึกครั้งเดียว","Many standards, one posting"),
             T("บันทึกครั้งเดียวเข้าทุกมาตรฐาน โดยแยกเฉพาะรายการปรับปรุง ผลต่างระหว่างบัญชีและภาษีจึงวัดได้สะอาด","post once into every standard, isolating adjustments, so the book-tax difference is measured cleanly.")),
        ]})

    # ══ SECTION 2 — SECURITY & CONTROL ══════════════════════════════════════
    S.append({"t":"divider","num":"2","accent":"coral","label":T("ส่วนที่","SECTION"),
        "title":T("ความปลอดภัยและการควบคุม","Security & control"),
        "subtitle":T("ออกแบบให้ผ่านการทดสอบเจาะระบบและการตรวจสอบระดับบริษัทมหาชน โดยตั้งค่าตั้งต้นให้ปลอดภัยเสมอ",
                     "Engineered to withstand penetration testing and public-company audit, with secure-by-default settings.")})

    S.append({"t":"stats","accent":"coral","section":T("ความปลอดภัยและการควบคุม","Security & control"),
        "kicker":T("ความปลอดภัย · 2.1","Security · 2.1"),
        "title":T("ความปลอดภัยในเชิงตัวเลข","Security by the numbers"),
        "intro":T("ผ่านการตรวจสอบโดยอิสระสองครั้งในปี 2569 ทั้งการทดสอบเจาะระบบภายในและการทบทวนโดยผู้เชี่ยวชาญภายนอก โดยแก้ไขครบทุกประเด็น",
                  "Reviewed independently twice in 2026 — an internal penetration test and an external expert review — with every finding remediated."),
        "stats":[
            ("282", T("มาตรการควบคุม","documented controls"), T("บันทึกครบ ไม่มีช่องว่างที่ยังเปิดอยู่","fully documented, with no open gap")),
            ("22", T("ประเด็นที่แก้ไขครบ","findings closed"), T("จากการทบทวนภายนอก แก้ไขและรวมเข้าระบบทั้งหมด","from the external review, all fixed and merged")),
            ("23", T("กฎการแยกหน้าที่","segregation rules"), T("ประเมินอัตโนมัติจากสิทธิ์จริงของผู้ใช้","evaluated from real user permissions")),
            ("344", T("ตารางที่แยกข้อมูล","isolated tables"), T("แยกข้อมูลถึงระดับฐานข้อมูล","isolated at the database layer")),
        ],
        "footer":T("การทดสอบเจาะระบบภายในระบุประเด็นระดับวิกฤตหนึ่งรายการ ระดับสูงหกรายการ และระดับกลางแปดรายการ ซึ่งได้รับการแก้ไขและตรวจยืนยันครบทุกรายการ",
                   "The internal test identified one critical, six high and eight medium findings, all remediated and re-verified.")})

    S.append({"t":"two_panel","accent":"coral","section":T("ความปลอดภัยและการควบคุม","Security & control"),
        "kicker":T("ความปลอดภัย · 2.2","Security · 2.2"),
        "title":T("การแยกข้อมูลระหว่างกิจการ","Separation of data between companies"),
        "left":(T("แยกที่ระดับฐานข้อมูล ไม่ใช่ระดับแอป","At the database, not the application"),"◧","teal",[
            (T("การรักษาความปลอดภัยระดับแถว","Row-level security"),
             T("ทุกตารางมีนโยบายที่ผูกกับกิจการและบังคับใช้ แม้เจ้าของตารางก็อยู่ภายใต้กฎ","every table has a policy tied to the company and forced, so even the table owner is subject to it.")),
            (T("บริบทเฉพาะธุรกรรม","Transaction-local context"),
             T("บริบทของกิจการถูกกำหนดเฉพาะภายในธุรกรรม จึงไม่รั่วข้ามการเชื่อมต่อที่ใช้ร่วมกัน","the company context is set only within a transaction, so it never bleeds across shared connections.")),
            (T("ตัวตนจากโทเคนที่ลงนาม","Identity from a signed token"),
             T("รหัสกิจการและบทบาทมาจากโทเคนที่เซิร์ฟเวอร์ลงนามเท่านั้น ปลอมผ่านส่วนหัวคำขอไม่ได้","the company and role come only from a server-signed token and cannot be forged through request headers.")),
        ]),
        "right":(T("ปฏิเสธการเริ่มระบบหากเสี่ยงต่อการรั่วไหล","Refuses to start if a leak is possible"),"◆","coral",[
            (T("ตรวจสอบก่อนเริ่มระบบ","Pre-boot checks"),
             T("ระบบจะไม่เริ่มทำงานหากบทบาทฐานข้อมูลมีสิทธิ์ข้ามการรักษาความปลอดภัย","the system will not start if the database role can bypass security.")),
            (T("บทบาทที่จำกัดสิทธิ์","A least-privilege role"),
             T("ระบบใช้งานจริงเชื่อมต่อด้วยบทบาทที่ไม่มีสิทธิ์พิเศษ โดยไม่มีทางเลือกยกเว้น","production connects with a non-privileged role, with no opt-out.")),
            (T("ตรวจสอบต่อเนื่องในการทดสอบ","Continuous verification"),
             T("การทดสอบพิสูจน์การแยกข้อมูลบนฐานข้อมูลจริงทุกครั้งที่ปรับปรุงระบบ","tests prove isolation on a real database on every release.")),
        ])})

    S.append({"t":"cards","accent":"coral","section":T("ความปลอดภัยและการควบคุม","Security & control"),"cols":3,
        "kicker":T("ความปลอดภัย · 2.3","Security · 2.3"),
        "title":T("ความปลอดภัยระดับแอปพลิเคชัน","Application-level security"),
        "intro":T("ผ่านการเสริมความแข็งแกร่งตามมาตรฐานความปลอดภัยสากล แล้วตรวจสอบโดยผู้เชี่ยวชาญอิสระ โดยตั้งค่าตั้งต้นให้ปลอดภัยเสมอ",
                  "Hardened to international security standards, then reviewed by independent experts, with secure-by-default settings."),
        "cards":[
            (T("นโยบายความปลอดภัยของเนื้อหา","Content security policy"),T("",""),
             T("สคริปต์ที่ถูกแทรกเข้ามาโดยไม่ได้รับอนุญาตจะถูกปฏิเสธ ปิดช่องโหว่การโจมตีข้ามไซต์","injected scripts are refused, closing the cross-site-scripting gap."),"coral"),
            (T("การป้องกันการเรียกดูภายใน","Server-side request protection"),T("",""),
             T("ปิดกั้นการเรียกไปยังที่อยู่ภายในและตรวจสอบซ้ำเมื่อส่งจริง","blocks calls to internal addresses and re-validates at send time."),"coral"),
            (T("การยืนยันเว็บฮุกด้วยลายเซ็น","Signed webhook authentication"),T("",""),
             T("ตรวจสอบลายเซ็นบนเนื้อหาดิบพร้อมกรอบเวลา ป้องกันการปลอมและการเล่นซ้ำ","verifies a signature over the raw body within a time window, preventing forgery and replay."),"violet"),
            (T("คีย์บริการเป็นผู้ทำที่ต้องมีผู้อนุมัติ","Keys as maker, not approver"),T("",""),
             T("คีย์บริการผูกกับผู้สร้างที่เป็นบุคคล จึงอนุมัติงานของตนเองไม่ได้","a service key adopts its human creator, so it cannot self-approve."),"violet"),
            (T("ความลับที่เข้ารหัสจัดเก็บ","Secrets encrypted at rest"),T("",""),
             T("โทเคนและความลับถูกเข้ารหัสด้วยการหมุนกุญแจ และไม่มีการฝังไว้ในโค้ด","tokens and secrets are encrypted with key rotation, and none are hard-coded."),"gold"),
            (T("การจัดการเซสชันและการจำกัดอัตรา","Sessions & rate limiting"),T("",""),
             T("โทเคนอยู่ในคุกกี้ที่สคริปต์อ่านไม่ได้ พร้อมการเพิกถอนทันทีและการจำกัดการเข้าสู่ระบบ","tokens sit in cookies scripts cannot read, with instant revocation and login rate limits."),"teal"),
        ]})

    S.append({"t":"two_panel","accent":"gold","section":T("ความปลอดภัยและการควบคุม","Security & control"),
        "kicker":T("ความปลอดภัย · 2.4","Security · 2.4"),
        "title":T("การควบคุมภายในระดับบริษัทมหาชน","Public-company internal control"),
        "left":(T("เมทริกซ์การควบคุมที่ทดสอบตัวเอง","A self-testing control matrix"),"≣","gold",[
            (T("มาตรการควบคุมที่สร้างจากโค้ด","Controls generated from code"),
             T("มาตรการหลายร้อยรายการเชื่อมกับมาตรฐานสากล สร้างจากซอร์สโค้ดจึงไม่คลาดเคลื่อน","hundreds of controls mapped to international frameworks, generated from source so they cannot drift.")),
            (T("การทดสอบประสิทธิผลอัตโนมัติ","Automated effectiveness tests"),
             T("การทดสอบตรวจพิสูจน์การควบคุมทุกครั้งที่ปรับปรุง การถดถอยจึงไม่หลุดออกไป","tests re-prove the controls on every release, so a regression cannot ship.")),
            (T("การอนุมัติแบบผู้ทำและผู้อนุมัติทั่วทั้งระบบ","Maker-checker across the system"),
             T("รายการบัญชี เงินเดือน การนับสต๊อก และการอนุมัติราคา ล้วนต้องมีผู้อนุมัติที่ต่างจากผู้ทำ","journals, payroll, stock counts and pricing all require an approver different from the maker.")),
        ]),
        "right":(T("การแยกหน้าที่และการควบคุมการยกเว้น","Segregation and exception control"),"⚖","violet",[
            (T("กฎการแยกหน้าที่ที่ประเมินอัตโนมัติ","Rules evaluated automatically"),
             T("ประเมินจากสิทธิ์จริงของผู้ใช้ ทั้งการปิดกั้นเมื่อให้สิทธิ์และรายงานความขัดแย้ง","evaluated from real permissions, blocking at grant time and reporting conflicts.")),
            (T("การยกเว้นต้องมีสองลายเซ็น","Exceptions need two signatures"),
             T("การยกเว้นที่มีเหตุผลรองรับต้องได้รับอนุมัติจากบุคคลอื่นและบันทึกไว้","a justified exception must be approved by a different person and logged.")),
            (T("การตรึงผลลัพธ์ทางการเงิน","Financial outputs pinned"),
             T("ผลลัพธ์ของบัญชี การจัดซื้อ และการวิเคราะห์ถูกเทียบกับค่าอ้างอิง การเปลี่ยนที่ไม่ตั้งใจจะถูกจับได้","accounting, procurement and analytics outputs are compared to a baseline, catching unintended change.")),
        ])})

    S.append({"t":"cards","accent":"coral","section":T("ความปลอดภัยและการควบคุม","Security & control"),"cols":3,
        "kicker":T("ความปลอดภัย · 2.5","Security · 2.5"),
        "title":T("การควบคุมเทคโนโลยี ร่องรอยการตรวจสอบ และมาตรฐาน","IT controls, audit trail and standards"),
        "cards":[
            (T("ร่องรอยการตรวจสอบที่แก้ไม่ได้","Immutable audit trail"),T("",""),
             T("บันทึกแบบเพิ่มได้อย่างเดียว การแก้หรือลบถูกปฏิเสธที่ระดับฐานข้อมูล และตรวจพบการแก้ไขได้","append-only, with edits and deletes refused at the database, and tampering detectable."),"coral"),
            (T("บันทึกการเปลี่ยนแปลงระดับฟิลด์","Field-level change log"),T("",""),
             T("บันทึกค่าก่อนและหลังของตารางการเงินหลักที่ระดับฐานข้อมูล โค้ดจึงข้ามไม่ได้","captures before-and-after values on core financial tables at the database, un-bypassable by code."),"coral"),
            (T("การรับรองสิทธิ์เข้าถึงตามรอบ","Access recertification"),T("",""),
             T("การทบทวนสิทธิ์ตามรอบที่การเพิกถอนจะลบสิทธิ์จริงและยุติเซสชัน","periodic access reviews where a revocation actually removes access and ends sessions."),"teal"),
            (T("การยืนยันตัวตนหลายปัจจัย","Multi-factor authentication"),T("",""),
             T("บังคับใช้กับบทบาททางการเงินและสิทธิ์สูง และจำกัดการเข้าสู่ระบบด้วยรหัสสั้น","enforced for finance and high-privilege roles, with quick-PIN login restricted."),"teal"),
            (T("มาตรฐานสากลและความเป็นส่วนตัว","Standards & privacy"),T("",""),
             T("ฐานหลักฐานชุดเดียวรองรับหลายมาตรฐาน และสิทธิ์ในการลบข้อมูลอยู่ร่วมกับร่องรอยที่แก้ไม่ได้","one evidence base serves several standards, and the right to erasure coexists with an immutable trail."),"violet"),
            (T("การจัดการการเปลี่ยนแปลงและการปฏิบัติการ","Change management & operations"),T("",""),
             T("การทบทวนโค้ด การแยกผู้นำขึ้นระบบออกจากผู้เขียน การสำรองข้อมูลที่ทดสอบแล้ว และแผนความต่อเนื่อง","code review, deployer-separated-from-author, tested backups and a continuity plan."),"gold"),
        ]})

    # ══ SECTION 3 — POS MODULES ═════════════════════════════════════════════
    S.append({"t":"divider","num":"3","accent":"cyan","label":T("ส่วนที่","SECTION"),
        "title":T("โมดูลในระบบขายหน้าร้าน","Point-of-sale modules"),
        "subtitle":T("ขอบเขตงานฝั่งหน้าร้านทั้งหมด ตั้งแต่การขายและร้านอาหาร ถึงกะการทำงาน อุปกรณ์ และช่องทางจัดส่ง",
                     "The full front-of-house footprint — from selling and restaurant operations to shifts, devices and delivery channels.")})

    S.append({"t":"cards","accent":"cyan","section":T("โมดูลในระบบขายหน้าร้าน","POS modules"),"cols":4,
        "kicker":T("ระบบขายหน้าร้าน · 3.1","Point of sale · 3.1"),
        "title":T("การขายและงานร้านอาหาร","Selling and restaurant operations"),
        "intro":T("สิบหกโมดูลฝั่งการขาย จัดกลุ่มตามการบริการหน้าร้าน งานรับประทานในร้าน และการปิดกะ โดยทุกโมดูลบันทึกลงบัญชีและอยู่ภายใต้การแยกหน้าที่",
                  "Sixteen selling modules, grouped by frontline service, dining and shift close — each posting to the ledger and governed by segregation of duties."),
        "cards":[
            ("◧",T("เครื่องขาย","Register"),T("หน้าจอขายและแอปติดตั้ง","Touch register & app"),"cyan"),
            ("▤",T("คำสั่งซื้อ","Orders"),T("จัดการคำสั่งซื้อ","Order management"),"cyan"),
            ("↺",T("การคืนสินค้า","Returns"),T("รับคืนและคืนเงิน","Returns & refunds"),"green"),
            ("₿",T("อนุมัติคืนเงิน","Refund approval"),T("อำนาจแยกต่างหาก","Separate authority"),"coral"),
            ("▦",T("บัตรกำนัล","Gift cards"),T("มูลค่าที่เก็บไว้","Stored value"),"gold"),
            ("◉",T("การพิมพ์","Printing"),T("ใบเสร็จและเอกสาร","Receipts & slips"),"teal"),
            ("⊞",T("โต๊ะ","Tables"),T("ผังร้านและสถานะ","Floor plan & status"),"cyan"),
            ("◷",T("การจอง","Reservations"),T("จองโต๊ะและคิว","Booking & queue"),"violet"),
            ("⬡",T("จอครัว","Kitchen display"),T("สถานะและเวลาปรุง","States & prep time"),"coral"),
            ("≡",T("เมนู","Menu"),T("รายการและตัวเลือก","Items & modifiers"),"teal"),
            ("◔",T("บุฟเฟต์","Buffet"),T("ราคาต่อหัว","Per-head pricing"),"gold"),
            ("◆",T("ทิป","Tips"),T("การจัดสรรทิป","Tip distribution"),"green"),
            ("▣",T("การควบคุมหน้าร้าน","POS control"),T("การกำกับหน้าร้าน","Front-of-house oversight"),"cyan"),
            ("₿",T("ลิ้นชักเงิน","Till"),T("การเปิด-ปิดกะ","Open & close shift"),"gold"),
            ("◱",T("ปิดวัน","Close of day"),T("รายงานสิ้นวัน","End-of-day report"),"teal"),
            ("◈",T("รหัสเข้าใช้","Quick PIN"),T("การเข้าใช้แบบรวดเร็ว","Fast sign-in"),"violet"),
        ]})

    S.append({"t":"cards","accent":"cyan","section":T("โมดูลในระบบขายหน้าร้าน","POS modules"),"cols":4,
        "kicker":T("ร้านและอุปกรณ์ · 3.2","Store & devices · 3.2"),
        "title":T("ร้าน อุปกรณ์ และการวิเคราะห์","Store, devices and analytics"),
        "intro":T("การจัดการร้าน อุปกรณ์ต่อพ่วง ช่องทางจัดส่ง และการวิเคราะห์ร้านอาหาร เชื่อมโยงกับคลัง การจัดซื้อ และงานสมาชิกอย่างไร้รอยต่อ",
                  "Store management, peripherals, delivery channels and restaurant analytics, connected seamlessly to inventory, procurement and loyalty."),
        "cards":[
            ("◇",T("การเคลม","Claims"),T("การเคลมสินค้า","Product claims"),"coral"),
            ("⇢",T("การจัดส่ง","Delivery"),T("งานจัดส่ง","Fulfilment"),"violet"),
            ("◫",T("ช่องทางจัดส่ง","Delivery channels"),T("แพลตฟอร์มภายนอก","External platforms"),"violet"),
            ("⌗",T("อุปกรณ์ต่อพ่วง","Peripherals"),T("เครื่องพิมพ์และลิ้นชัก","Printers & drawers"),"teal"),
            ("▭",T("เครื่องรับบัตร","Card terminals"),T("การรับชำระ","Card acceptance"),"gold"),
            ("◈",T("บัญชีรับเงิน","Payment accounts"),T("ช่องทางรับเงิน","Tender accounts"),"cyan"),
            ("◔",T("ต้นทุนอาหาร","Food cost"),T("ต้นทุนต่อเมนู","Cost per dish"),"gold"),
            ("◐",T("วิเคราะห์ร้านอาหาร","Restaurant analytics"),T("วิศวกรรมเมนู","Menu engineering"),"violet"),
            ("⊞",T("แผนการผลิต","Production plan"),T("การเตรียมครัว","Kitchen prep"),"cyan"),
            ("◆",T("สมาชิกหน้าร้าน","Loyalty at POS"),T("งานสมาชิก","Member operations"),"gold"),
            ("₧",T("สมุดภาษี","Fiscal journal"),T("ภาษีอิเล็กทรอนิกส์","Electronic tax"),"coral"),
            ("▣",T("สั่งของเข้าร้าน","Store requisition"),T("การเบิกของ","Supply ordering"),"teal"),
        ]})

    # ══ SECTION 4 — ERP MODULES ═════════════════════════════════════════════
    S.append({"t":"divider","num":"4","accent":"teal","label":T("ส่วนที่","SECTION"),
        "title":T("โมดูลในระบบหลังบ้าน","ERP modules"),
        "subtitle":T("ขอบเขตงานฝั่งหลังบ้านทั้งหมด จัดเป็นโดเมนหลัก ตั้งแต่การขายและซัพพลายเชน ถึงการเงิน บุคคล โครงการ และการวางแผน",
                     "The full back-office footprint, organised into domains — from sales and supply chain to finance, people, projects and planning.")})

    S.append({"t":"cards","accent":"teal","section":T("โมดูลในระบบหลังบ้าน","ERP modules"),"cols":4,
        "kicker":T("ขายและซัพพลายเชน · 4.1","Sales & supply chain · 4.1"),
        "title":T("ลูกค้า การขาย และซัพพลายเชน","Customers, selling and supply chain"),
        "cards":[
            ("◎",T("ลูกค้าสัมพันธ์","CRM workspace"),T("ไปป์ไลน์และดีล","Pipeline & deals"),"violet"),
            ("◔",T("ทะเบียนลูกค้า","Customer master"),T("มุมมองรอบด้าน","360 view"),"violet"),
            ("◈",T("การตลาด","Marketing"),T("แคมเปญและผลตอบแทน","Campaigns & ROI"),"coral"),
            ("▤",T("ใบเสนอราคา","Quoting"),T("กำหนดค่าและราคา","Configure & price"),"violet"),
            ("◇",T("บริการและประกัน","Service & warranty"),T("บริการหลังการขาย","After-sales"),"teal"),
            ("◆",T("สมาชิก","Loyalty"),T("คะแนนและเกม","Points & gamification"),"gold"),
            ("₵",T("ราคาและโปรโมชัน","Pricing & promotions"),T("กฎราคา","Price rules"),"coral"),
            ("⌂",T("สาขา","Branches"),T("การจัดการสาขา","Branch management"),"teal"),
            ("▦",T("คลังสินค้า","Inventory & WMS"),T("สต๊อกและคลัง 3 มิติ","Stock & 3D warehouse"),"cyan"),
            ("◱",T("การนับสต๊อก","Stocktaking"),T("นับตามความเสี่ยง","Risk-based counts"),"cyan"),
            ("⇢",T("รับและโอนของ","Receive & transfer"),T("การเคลื่อนย้าย","Goods movement"),"cyan"),
            ("◧",T("ต้นทุน","Costing"),T("ต้นทุนและนำเข้า","Cost & landed"),"gold"),
            ("▣",T("การจัดซื้อ","Procurement"),T("คำขอถึงการจ่าย","Requisition to pay"),"teal"),
            ("◫",T("ผู้ขายและสอบราคา","Suppliers & RFQ"),T("การจัดหา","Sourcing"),"teal"),
            ("⬡",T("การผลิต","Manufacturing"),T("สูตรและคำสั่งผลิต","BOM & work orders"),"violet"),
            ("◇",T("คุณภาพ","Quality"),T("ข้อบกพร่องและแก้ไข","Non-conformance & CAPA"),"coral"),
        ]})

    S.append({"t":"cards","accent":"gold","section":T("โมดูลในระบบหลังบ้าน","ERP modules"),"cols":4,
        "kicker":T("การเงินและบัญชี · 4.2","Finance & accounting · 4.2"),
        "title":T("การเงิน บัญชี และภาษี","Finance, accounting and tax"),
        "cards":[
            ("₿",T("ลูกหนี้และเจ้าหนี้","Receivables & payables"),T("เงินทุนหมุนเวียน","Working capital"),"teal"),
            ("◔",T("การ์ดคู่ค้า","Party cards"),T("ใบแสดงยอด","Statements"),"teal"),
            ("◈",T("การจ่ายเงิน","Disbursements"),T("การปล่อยเงิน","Cash release"),"coral"),
            ("◇",T("การคุมเครดิต","Credit control"),T("การระงับเครดิต","Credit holds"),"coral"),
            ("≣",T("บัญชีแยกประเภท","General ledger"),T("แกนบัญชีคู่","Double-entry core"),"gold"),
            ("⧉",T("ผังบัญชี","Chart of accounts"),T("โครงสร้างบัญชี","Account structure"),"gold"),
            ("◕",T("การรับรู้รายได้","Revenue recognition"),T("ตามมาตรฐาน","To the standard"),"green"),
            ("▤",T("สินทรัพย์ถาวร","Fixed assets"),T("วงจรสินทรัพย์","Asset lifecycle"),"cyan"),
            ("⚖",T("สัญญาเช่า","Leases"),T("ตามมาตรฐานสากล","To IFRS"),"cyan"),
            ("◧",T("ภาษีรอตัดบัญชี","Deferred tax"),T("ผลต่างชั่วคราว","Temporary differences"),"violet"),
            ("⌂",T("ธนาคารและกระทบยอด","Bank & reconciliation"),T("การจับคู่","Matching"),"teal"),
            ("◆",T("การอนุมัติ","Approvals"),T("ศูนย์อนุมัติ","Approval centre"),"gold"),
            ("◐",T("ศูนย์บัญชาการ","Command centre"),T("ห้องควบคุมการเงิน","Finance cockpit"),"violet"),
            ("⧉",T("งบรวม","Consolidation"),T("งบระดับกลุ่ม","Group reporting"),"violet"),
            ("₧",T("ภาษี","Tax"),T("มูลค่าเพิ่มและหัก ณ ที่จ่าย","VAT & withholding"),"coral"),
            ("◈",T("การบริหารเงินสด","Treasury"),T("สภาพคล่องและตราสาร","Liquidity & instruments"),"teal"),
        ]})

    S.append({"t":"cards","accent":"violet","section":T("โมดูลในระบบหลังบ้าน","ERP modules"),"cols":4,
        "kicker":T("บุคคล โครงการ และการกำกับ · 4.3","People, projects & governance · 4.3"),
        "title":T("บุคคล โครงการ การวางแผน และการกำกับดูแล","People, projects, planning and governance"),
        "cards":[
            ("◔",T("ทรัพยากรบุคคล","Human capital"),T("บุคคลและองค์กร","People & org"),"violet"),
            ("◆",T("การประเมินผล","Performance"),T("การประเมิน","Appraisals"),"violet"),
            ("₿",T("เงินเดือน","Payroll"),T("ตามกฎหมายไทย","Thai-statutory"),"gold"),
            ("◈",T("บริการตนเอง","Self-service"),T("สำหรับพนักงาน","For employees"),"teal"),
            ("◨",T("โครงการ","Projects"),T("บริหารโครงการ","Project management"),"teal"),
            ("⌂",T("อสังหาริมทรัพย์","Real estate"),T("อสังหาและก่อสร้าง","Property & construction"),"gold"),
            ("◐",T("พอร์ตโฟลิโอ","Portfolio"),T("มุมมองรวมโครงการ","Portfolio view"),"teal"),
            ("◑",T("การวางแผนและงบ","Planning & budget"),T("การวางแผนการเงิน","Financial planning"),"cyan"),
            ("◒",T("อุปสงค์และกำไร","Demand & profitability"),T("พยากรณ์และปันส่วน","Forecast & allocate"),"cyan"),
            ("◐",T("การวิเคราะห์","Analytics"),T("รายงานและการสอบถาม","Reports & query"),"violet"),
            ("◇",T("การควบคุมและตรวจสอบ","Controls & audit"),T("การกำกับการควบคุม","Control oversight"),"coral"),
            ("⧉",T("ธรรมาภิบาล","Governance"),T("การกำกับดูแลกิจการ","Corporate governance"),"coral"),
            ("✦",T("ปัญญาประดิษฐ์","Artificial intelligence"),T("ผู้ช่วยและตัวแทน","Assistant & agent"),"green"),
            ("▦",T("ข้อมูลหลัก","Master data"),T("การกำกับข้อมูล","Data governance"),"teal"),
            ("◭",T("การปรับแต่ง","Customisation"),T("แบบไม่ต้องเขียนโค้ด","No-code studio"),"gold"),
            ("◫",T("การเชื่อมต่อ","Integrations"),T("เอพีไอและการยืนยันตัวตน","API & sign-on"),"violet"),
        ]})

    # ══ SECTION 5 — DEEP DIVES ══════════════════════════════════════════════
    S.append({"t":"divider","num":"5","accent":"violet","label":T("ส่วนที่","SECTION"),
        "title":T("เจาะลึกแต่ละโมดูล","Module deep dive"),
        "subtitle":T("รายละเอียดเชิงลึกของแต่ละโมดูล ทั้งความสามารถ การควบคุม และจุดเด่น พร้อมรหัสการควบคุมที่อ้างอิงได้",
                     "Each module in depth — its capabilities, controls and distinctive strengths, with referenceable control identifiers.")})
    S.extend(_deep_dive())

    # ══ SECTION 6 — FURTHER CONSIDERATIONS ══════════════════════════════════
    S.append({"t":"divider","num":"6","accent":"gold","label":T("ส่วนที่","SECTION"),
        "title":T("ข้อควรพิจารณาเพิ่มเติม","Further considerations"),
        "subtitle":T("การนำไปใช้ สถาปัตยกรรม แพ็กเกจ การรองรับ และก้าวต่อไปในการทำงานร่วมกัน",
                     "Adoption, architecture, packaging, support and the path forward together.")})

    S.append({"t":"bullets","accent":"teal","section":T("ข้อควรพิจารณาเพิ่มเติม","Further considerations"),"twocol":True,
        "kicker":T("เพิ่มเติม · 6.1","Further · 6.1"),
        "title":T("การนำไปใช้และการเริ่มต้นใช้งาน","Adoption and onboarding"),
        "intro":T("ออกแบบให้เริ่มใช้งานได้อย่างรวดเร็ว ด้วยการจัดตั้งกิจการแบบครบในขั้นตอนเดียวและเครื่องมือย้ายข้อมูลในตัว",
                  "Designed for a fast start, with atomic company provisioning and built-in data migration."),
        "bullets":[
            (T("จัดตั้งครบในขั้นตอนเดียว","Provisioned in one step"),
             T("สร้างกิจการ ผู้ดูแล ช่วงทดลอง งวดบัญชี และผังบัญชีตามอุตสาหกรรมในธุรกรรมเดียว พร้อมบันทึกได้ทันที","company, administrator, trial, fiscal periods and an industry chart of accounts in one transaction, ready to post.")),
            (T("แม่แบบผังบัญชีตามอุตสาหกรรม","Industry chart templates"),
             T("แม่แบบสำหรับร้านอาหาร ค้าปลีก การกระจายสินค้า และบริการ พร้อมใช้ตั้งแต่วันแรก","templates for restaurant, retail, distribution and services, ready from day one.")),
            (T("ย้ายข้อมูลอย่างมีการควบคุม","Controlled data migration"),
             T("นำเข้าและส่งออกทุกประเภทข้อมูล ด้วยการตรวจสอบแบบทดลอง การแสดงตัวอย่าง และการยืนยัน","import and export every entity, with dry-run validation, preview and commit.")),
            (T("ยอดยกมาที่ควบคุม","Controlled opening balances"),
             T("ยอดยกมาตอนเริ่มระบบผ่านการอนุมัติแบบผู้ทำและผู้อนุมัติเช่นเดียวกับรายการอื่น","go-live balances pass the same maker-checker as any other entry.")),
            (T("เริ่มใช้งานได้สามช่องทาง","Three ways to onboard"),
             T("สร้างโดยตรง ลิงก์เชิญแบบใช้ครั้งเดียว หรือคิวคำขอเข้าใช้ โดยการเปิดใช้เองถูกปิดในระบบจริง","direct create, a single-use invite, or a request queue, with public self-signup disabled in production.")),
            (T("เอกสารเป็นส่วนหนึ่งของงาน","Documentation as part of the work"),
             T("เอกสารกระบวนการ คู่มือผู้ใช้ และเอกสารทดสอบ ปรับปรุงไปพร้อมกับระบบเสมอ","process narratives, user manuals and test documents are updated alongside the system.")),
        ]})

    S.append({"t":"cards","accent":"violet","section":T("ข้อควรพิจารณาเพิ่มเติม","Further considerations"),"cols":3,
        "kicker":T("เพิ่มเติม · 6.2","Further · 6.2"),
        "title":T("สถาปัตยกรรม ความน่าเชื่อถือ และการปฏิบัติการ","Architecture, reliability and operations"),
        "cards":[
            (T("เทคโนโลยีที่ทันสมัย","A modern stack"),T("",""),
             T("สร้างบนกรอบงานฝั่งเซิร์ฟเวอร์และเว็บที่ทันสมัย ร่วมกับฐานข้อมูลที่รองรับหลายกิจการ","built on a modern server and web framework with a multi-company database."),"teal"),
            (T("สำรองและกู้คืนที่ทดสอบแล้ว","Tested backup and restore"),T("",""),
             T("การสำรองข้อมูลอัตโนมัติพร้อมขั้นตอนการกู้คืนที่ได้รับการทดสอบจริง","automated backups with a genuinely tested restore procedure."),"teal"),
            (T("แผนความต่อเนื่องพร้อมเป้าหมาย","A continuity plan with targets"),T("",""),
             T("แผนกู้คืนจากภัยพิบัติและความต่อเนื่องทางธุรกิจ พร้อมเป้าหมายด้านเวลาและข้อมูล","a disaster-recovery and business-continuity plan with time and data targets."),"violet"),
            (T("การเฝ้าระวังและแจ้งเตือน","Monitoring and alerting"),T("",""),
             T("สัญญาณเฝ้าระวังตลอดเวลา พร้อมการแจ้งเตือนงานที่ล้มเหลวและการเก็บกวาดงานค้าง","always-on signals, with failed-job alerting and stuck-job recovery."),"violet"),
            (T("ด่านตรวจสอบที่เข้มงวด","Rigorous quality gates"),T("",""),
             T("การตรวจชนิดข้อมูล การประกอบระบบ การทดสอบการควบคุม และการเทียบผลลัพธ์ ก่อนการรวมทุกครั้ง","type checks, build, control tests and output comparison before every merge."),"gold"),
            (T("ออกแบบให้ทำซ้ำได้อย่างปลอดภัย","Safe to repeat by design"),T("",""),
             T("การบันทึกซ้ำไม่สร้างผลกระทบซ้อน และทุกการเปลี่ยนหลายตารางอยู่ในธุรกรรมเดียว","repeating a posting has no double effect, and every multi-table change is one transaction."),"coral"),
        ]})

    S.append({"t":"bullets","accent":"gold","section":T("ข้อควรพิจารณาเพิ่มเติม","Further considerations"),
        "kicker":T("เพิ่มเติม · 6.3","Further · 6.3"),
        "title":T("แพ็กเกจและความยืดหยุ่น","Packaging and flexibility"),
        "intro":T("ระบบเป็นโมดูลอย่างแท้จริง เปิดหรือปิดโมดูล ปรับส่วนงาน และกำหนดแบรนด์ได้ต่อกิจการ",
                  "The system is genuinely modular — enable or disable modules, adjust surfaces and set branding per company."),
        "bullets":[
            (T("ควบคุมโมดูลต่อกิจการ","Per-company module control"),
             T("เปิดหรือปิดทั้งโมดูลต่อกิจการโดยไม่กระทบกิจการอื่น","enable or disable whole modules per company without affecting others.")),
            (T("โมดูลเฉพาะอุตสาหกรรม","Industry packs"),
             T("เปิดใช้เฉพาะส่วนที่จำเป็น เช่น งานก่อสร้างและอสังหาริมทรัพย์ หรือร้านอาหาร","enable only what is needed — construction and real estate, or restaurant.")),
            (T("การกำหนดแบรนด์","White-label branding"),
             T("ปรับสี โลโก้ และแม่แบบเอกสารได้ทั้งระบบต่อกิจการ","adjust colours, logo and document templates across the app, per company.")),
            (T("ตัวชี้วัดธุรกิจแบบบริการ","Built-in SaaS metrics"),
             T("ติดตามรายได้ประจำ การเติบโต และการเลิกใช้ สำหรับผู้ให้บริการต่อ","track recurring revenue, growth and churn, for operators who resell.")),
        ]})

    S.append({"t":"cards","accent":"violet","section":T("ข้อควรพิจารณาเพิ่มเติม","Further considerations"),"cols":3,
        "kicker":T("เพิ่มเติม · 6.4","Further · 6.4"),
        "title":T("ระบบนิเวศและการเชื่อมต่อ","Ecosystem and integration"),
        "cards":[
            (T("เอพีไอสาธารณะและพอร์ทัลนักพัฒนา","Public API & developer portal"),T("",""),
             T("เปิดเอพีไอที่จำกัดขอบเขตและอัตราการเรียก แยกข้อมูลตามกิจการ พร้อมเอกสารมาตรฐาน","a scope-gated, rate-limited API isolated by company, with standard documentation."),"violet"),
            (T("เว็บฮุกที่ลงลายมือชื่อ","Signed webhooks"),T("",""),
             T("ส่งเหตุการณ์ที่ลงลายมือชื่อพร้อมกรอบเวลา และเก็บความลับด้วยการเข้ารหัส","deliver signed events within a time window, with secrets stored encrypted."),"violet"),
            (T("การยืนยันตัวตนองค์กร","Enterprise sign-on"),T("",""),
             T("รองรับการยืนยันตัวตนแบบรวมศูนย์และการจัดการผู้ใช้ โดยผู้พ้นสภาพจะถูกระงับไม่ใช่ลบ","support federated sign-on and user lifecycle, deactivating leavers rather than deleting them."),"teal"),
            (T("ช่องทางข้อความ","Messaging channels"),T("",""),
             T("ผสาน LINE อีเมล และเอสเอ็มเอส สำหรับการแจ้งเตือน รายงาน และการตลาด","integrate LINE, email and SMS for alerts, reports and marketing."),"green"),
            (T("ตลาดจัดส่งอาหาร","Delivery marketplaces"),T("",""),
             T("รับคำสั่งซื้อจากแพลตฟอร์มจัดส่งชั้นนำ พร้อมซิงก์เมนูและระงับรายการที่หมด","receive orders from leading delivery platforms, with menu sync and auto-pause."),"gold"),
            (T("ชุดโลคัลไลซ์","Localisation packs"),T("",""),
             T("รองรับผังบัญชี ภาษี และภาษาต่อประเทศ พร้อมเครื่องมือใบกำกับอิเล็กทรอนิกส์","support per-country charts, tax and language, with e-invoicing adapters."),"cyan"),
        ]})

    S.append({"t":"bullets","accent":"teal","section":T("ข้อควรพิจารณาเพิ่มเติม","Further considerations"),"twocol":True,
        "kicker":T("เพิ่มเติม · 6.5","Further · 6.5"),
        "title":T("เอกสาร การรองรับ และคุณภาพ","Documentation, support and quality"),
        "intro":T("เอกสารเป็นผลงานส่งมอบชั้นหนึ่ง จัดเตรียมสำหรับการตรวจสอบตามมาตรฐานและการใช้งานจริง",
                  "Documentation is a first-class deliverable, prepared for standards audit and real-world use."),
        "bullets":[
            (T("เอกสารกระบวนการต่อวงจร","Process narratives per cycle"),
             T("จัดทำในรูปแบบมาตรฐาน พร้อมแผนภาพลำดับงาน เมทริกซ์การควบคุม และประวัติการแก้ไข","in a standard format, with workflow diagrams, control matrices and revision history.")),
            (T("คู่มือผู้ใช้ต่อโมดูล","User manuals per module"),
             T("ครอบคลุมขั้นตอน สิทธิ์ที่ต้องใช้ จุดควบคุม และคำถามที่พบบ่อย","covering steps, required permissions, control points and frequently asked questions.")),
            (T("เอกสารทดสอบและการสอบทาน","Test and traceability documents"),
             T("กรณีทดสอบทั้งด้านบวกและด้านการควบคุม ผูกกับรหัสการควบคุม","positive and control test cases, linked to control identifiers.")),
            (T("รายงานสถานะการควบคุมอย่างตรงไปตรงมา","Honest control-status reporting"),
             T("ระบุชัดว่าการนำไปใช้ไม่เท่ากับการรับรองจากภายนอก โปร่งใสต่อผู้ตรวจสอบ","stating plainly that implementation is not external attestation — transparent to auditors.")),
            (T("รองรับสองภาษา","Bilingual throughout"),
             T("ส่วนติดต่อผู้ใช้และเอกสารรองรับทั้งภาษาไทยและภาษาอังกฤษ","the interface and documentation support both Thai and English.")),
            (T("ศูนย์การควบคุมในระบบ","An in-app control centre"),
             T("ผู้ตรวจสอบเปิดดูรายการมาตรการควบคุมและหลักฐานได้ภายในตัวสินค้า","auditors can browse the control inventory and evidence inside the product.")),
        ]})

    S.append({"t":"stats","accent":"gold","section":T("ข้อควรพิจารณาเพิ่มเติม","Further considerations"),
        "kicker":T("เพิ่มเติม · 6.6","Further · 6.6"),
        "title":T("ความพร้อมเชิงกลยุทธ์","Strategic readiness"),
        "intro":T("Invisible ERP เป็นมากกว่าระบบปฏิบัติงาน แต่เป็นสินทรัพย์เชิงกลยุทธ์สำหรับการเติบโตและการระดมทุน",
                  "Invisible ERP is more than an operating system — it is a strategic asset for growth and capital raising."),
        "stats":[
            ("4", T("มาตรฐานที่รองรับ","standards supported"), T("จากฐานหลักฐานชุดเดียว","from a single evidence base")),
            ("3", T("มาตรฐานบัญชีขนาน","parallel accounting bases"), T("บันทึกครั้งเดียว รายงานได้หลายชุด","post once, report under several")),
            ("98%", T("การควบคุมที่ทดสอบได้","of controls tested"), T("ด้วยการทดสอบอัตโนมัติต่อเนื่อง","by continuous automated testing")),
            ("0", T("ช่องว่างที่เปิดอยู่","open control gaps"), T("ในทะเบียนมาตรการควบคุมปัจจุบัน","in the current control register")),
        ],
        "footer":T("การควบคุมภายในที่แข็งแรงตั้งแต่ต้น ช่วยลดต้นทุนการแก้ไข เร่งการตรวจสอบ และเพิ่มมูลค่าองค์กร",
                   "Strong internal control from the outset lowers remediation cost, speeds audit and adds enterprise value.")})

    S.append({"t":"cards","accent":"green","section":T("ข้อควรพิจารณาเพิ่มเติม","Further considerations"),"cols":3,
        "kicker":T("เพิ่มเติม · 6.7","Further · 6.7"),
        "title":T("หกเหตุผลที่ผู้บริหารการเงินเลือกเรา","Six reasons finance leaders choose us"),
        "cards":[
            (T("พิสูจน์ได้ ไม่ใช่คำกล่าวอ้าง","Proof, not claims"),T("",""),
             T("มาตรการควบคุมที่บันทึกครบ ทดสอบอัตโนมัติเป็นส่วนใหญ่ และไม่มีช่องว่างที่เปิดอยู่","controls fully documented, mostly tested automatically, with no open gap."),"green"),
            (T("แยกข้อมูลที่ปฏิเสธการเริ่มหากเสี่ยง","Isolation that fails safe"),T("",""),
             T("การแยกข้อมูลระดับฐานข้อมูลที่ปฏิเสธการเริ่มระบบหากตั้งค่าเสี่ยง","database-level isolation that refuses to start if misconfigured."),"teal"),
            (T("ผ่านการตรวจสอบจากภายนอก","Externally reviewed"),T("",""),
             T("ประเด็นจากการทบทวนภายนอกได้รับการแก้ไขครบ และการทดสอบเจาะระบบได้รับการยืนยันซ้ำ","external-review findings all closed, and penetration testing re-verified."),"coral"),
            (T("ร่องรอยที่อยู่รอดการลบข้อมูล","A trail that survives erasure"),T("",""),
             T("ความสมบูรณ์ของร่องรอยการตรวจสอบอยู่ร่วมกับสิทธิ์ในการลบข้อมูลส่วนบุคคลได้","audit-trail integrity coexists with the right to erase personal data."),"violet"),
            (T("ฐานหลักฐานเดียวหลายมาตรฐาน","One base, many standards"),T("",""),
             T("ฐานหลักฐานชุดเดียวรองรับหลายมาตรฐาน ลดต้นทุนการปฏิบัติตามอย่างมีนัยสำคัญ","one evidence base serves several standards, cutting compliance cost materially."),"gold"),
            (T("ซื่อสัตย์โดยการออกแบบ","Honest by design"),T("",""),
             T("กลไกตรวจสอบห้ามการกล่าวอ้างเกินจริง ซึ่งเป็นสิ่งที่ผู้ตรวจสอบเชื่อถือที่สุด","a guard forbids overstatement — what auditors trust most."),"cyan"),
        ]})

    S.append({"t":"bullets","accent":"teal","section":T("ข้อควรพิจารณาเพิ่มเติม","Further considerations"),
        "kicker":T("เพิ่มเติม · 6.8","Further · 6.8"),
        "title":T("สรุปภาพรวมทั้งหมด","In summary"),
        "intro":T("Invisible ERP คือแพลตฟอร์มเดียวที่รวมการดำเนินงาน การเงิน และการควบคุมภายในระดับบริษัทมหาชน สำหรับธุรกิจไทยที่มุ่งเติบโตอย่างมั่นคง",
                  "Invisible ERP is the one platform that unites operations, finance and public-company internal control, for Thai businesses set on durable growth."),
        "bullets":[
            (T("ครบวงจร","Complete"),
             T("รวมหน้าร้าน หลังบ้าน ลูกค้าสัมพันธ์ สมาชิก และพอร์ทัลลูกค้า บนแกนข้อมูลและสิทธิ์เดียว","point of sale, back office, CRM, loyalty and a customer portal on one data-and-permission spine.")),
            (T("ควบคุมรัดกุม","Rigorously controlled"),
             T("การอนุมัติที่บังคับแม้กับผู้ดูแลระบบ การแยกหน้าที่ และร่องรอยการตรวจสอบที่แก้ไม่ได้","maker-checker enforced even against the administrator, segregation of duties and an immutable trail.")),
            (T("รองรับกฎหมายไทยอย่างแท้จริง","Genuinely Thai-compliant"),
             T("ใบกำกับภาษีอิเล็กทรอนิกส์ที่ลงลายมือชื่อ แบบภาษีครบถ้วน พร้อมเพย์ และ LINE","signed e-Tax invoices, complete returns, PromptPay and LINE.")),
            (T("ได้มาตรฐานสากล","To international standards"),
             T("การรับรู้รายได้ สัญญาเช่า เครื่องมือทางการเงิน หลายมาตรฐานบัญชี และงบรวมข้ามสกุลเงิน","revenue, leases, financial instruments, multi-GAAP and cross-currency consolidation.")),
            (T("ฉลาดและปรับได้","Intelligent and adaptable"),
             T("ผู้ช่วยปัญญาประดิษฐ์ที่ถูกกั้นจากบัญชี การวิเคราะห์ที่เจาะลงถึงบัญชี และการปรับแต่งโดยไม่ต้องเขียนโค้ด","an AI fenced from the ledger, analytics that drill to it, and no-code customisation.")),
        ]})

    # ── Closing ──────────────────────────────────────────────────────────────
    S.append({"t":"closing",
        "kicker":T("ก้าวต่อไปกับ Invisible ERP","The next step with Invisible ERP"),
        "title":T("พร้อมยกระดับธุรกิจของท่าน","Ready to elevate your business"),
        "subtitle":T("เรายินดีสาธิตระบบจริงกับข้อมูลของท่าน และหารือแนวทางการนำไปใช้ที่เหมาะกับองค์กร",
                     "We would be glad to demonstrate the system with your own data and discuss an adoption path that fits your organisation."),
        "contacts":[
            (T("นัดหมายการสาธิต","Arrange a demonstration"), T("ทีมงาน Invisible Consulting","The Invisible Consulting team")),
            (T("อีเมล","Email"), "hello@invisible-erp.com"),
            (T("เว็บไซต์","Website"), "www.invisible-erp.com"),
        ]})

    return S


if __name__ == "__main__":
    from collections import Counter
    for lang in ("th","en"):
        set_lang(lang)
        specs = build_specs()
        c = Counter(s["t"] for s in specs)
        print(f"[{lang}] total slides: {len(specs)}  ", dict(c))

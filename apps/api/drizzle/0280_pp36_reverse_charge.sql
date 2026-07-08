-- 5.6 (PP36) — reverse-charge / self-assessed VAT on imported services (ประมวลรัษฎากร ม.83/6).
-- A bill for services rendered from an offshore/non-VAT-registered supplier carries NO input VAT on the
-- vendor invoice; the Thai payer must self-assess 7% output VAT, remit it via ภ.พ.36 (due the 7th of the
-- following month), and may then claim it as input VAT. This flag marks such a bill so the ภ.พ.36 report
-- and the self-assessment GL leg (Dr 1300 Input VAT / Cr 2120 PP36 VAT Payable) are driven off it.
-- DEFAULT false ⇒ every existing bill is an ordinary domestic bill (INERT — no behaviour change).
ALTER TABLE ap_transactions ADD COLUMN IF NOT EXISTS reverse_charge boolean DEFAULT false;

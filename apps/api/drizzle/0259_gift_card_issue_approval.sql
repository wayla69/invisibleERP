-- Gift-card issuance maker-checker (maker-checker audit gap G1). A gift card is a 2200 Customer-Deposits
-- liability (cash-equivalent). Issuing one above the approval threshold now creates it as PendingApproval
-- and posts NO GL until a DIFFERENT user approves it (issuedBy ≠ approver → SOD_VIOLATION); small face
-- values still auto-issue to keep the till fast. This adds the PendingApproval value to the enum.
ALTER TYPE "gift_card_status" ADD VALUE IF NOT EXISTS 'PendingApproval';

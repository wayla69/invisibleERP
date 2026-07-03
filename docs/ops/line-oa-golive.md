# LINE Official Account — production go-live runbook (LP-1, docs/31)

> **Audience:** shop owner / tenant admin (perm `users` or `exec`) · **Time:** ~15 minutes
> **Outcome:** the shop's own LINE OA sends real notifications, and staff chat (link/PR/approve/…,
> docs/30) works over a signature-verified webhook. Until then the channel runs on the platform env
> token or ⚪ mock (messages logged but nothing leaves the building).

## What you need

- A LINE account able to create an Official Account (or your existing OA).
- Admin access to the ERP **Settings → ผู้ให้บริการข้อความ (Messaging providers)** page.
- The ERP API must be reachable from the internet over HTTPS (LINE will POST to it).

## Steps

1. **Create the OA + Messaging API channel.** At [manager.line.biz](https://manager.line.biz) create
   (or pick) your Official Account → Settings → Messaging API → enable it. This creates a channel in
   the [LINE Developers console](https://developers.line.biz).
2. **Turn off auto-reply.** In LINE Official Account Manager → Response settings: disable
   greeting/auto-response (or set to Manual) — otherwise LINE's canned replies race the ERP's chat
   replies.
3. **Copy the two credentials** from LINE Developers console → your channel:
   - **Channel secret** (Basic settings tab) — authenticates every webhook delivery.
   - **Channel access token** (Messaging API tab → issue a long-lived token) — lets the ERP push.
4. **Paste into the ERP.** Settings → Messaging providers → LINE Official Account: enter the token
   **and** the secret (both are required — the ERP refuses token-only creds because the webhook
   fail-closes without the secret in production), save. Secrets are AES-256-GCM encrypted at rest and
   write-only (the UI can never read them back).
5. **Set the webhook URL.** Copy the URL shown in the card's go-live panel
   (`https://<api-host>/api/line/webhook/<shop-code>`) → LINE Developers console → Messaging API →
   Webhook URL → paste → **Verify** → enable *Use webhook*.
6. **Confirm receipt health.** Back in the ERP settings card the panel should show
   🟢 *รับ webhook ล่าสุดสำเร็จ (ยืนยันลายเซ็นแล้ว)* with a fresh timestamp (the console's Verify —
   or any chat message to the OA — produces it). 🔴 *ลายเซ็นไม่ถูกต้อง* means the saved secret doesn't
   match the channel — re-copy step 3.
7. **Test the push path.** Link your own LINE first if you haven't (Requisitions page → เชื่อมต่อ
   LINE → send `link <code>` to the OA), then press **[ส่งข้อความทดสอบถึง LINE ของฉัน]**. A
   `NOT_LINKED` error means your ERP account has no linked LINE yet — that's step 7a, not a channel
   problem.
8. **Go-live check.** The channel badge should read 🟢 *พร้อมใช้งาน — ผู้ให้บริการของร้าน*
   (`resolved_provider: tenant`). Staff can now `link` and use the chat commands; workflow/petty-cash
   /leave/digest notifications ride the same token.

## Single-tenant env shortcut

A one-shop deployment can skip per-tenant creds and set the platform env `LINE_CHANNEL_TOKEN`
(push works; badge shows 🟡 *ใช้ผู้ให้บริการกลาง*). The webhook still needs the per-tenant secret to
verify chat in production — env-only setups without a saved secret get `WEBHOOK_UNVERIFIED` (fail
closed), so production chat always requires step 4.

## Token rotation / revocation

Re-issue the channel access token in the LINE console, paste the new token **and secret** (creds are
replaced wholesale) into Settings, save — the old token stops being used on the next send. Rotating
the Channel secret: update LINE console and the ERP together; deliveries signed with the old secret
will show 🔴 `bad_signature` until both sides match. For offboarding a staff member's chat access use
the admin link registry (Settings → manual `11-administration.md` §LINE) — force-unlink kills the
channel immediately.

## PDPA / data-residency note

What LINE sees: your OA's chat messages and the LINE userIds of followers/linked staff. What the ERP
sends to LINE: notification/digest text (may contain document numbers, amounts, item names) pushed to
linked recipients. No citizen IDs, payroll detail, or customer PII are pushed by any built-in
notification. Chat images (`attach`) travel from LINE's content API into the ERP, not the reverse.
Cover the OA relationship in your privacy notice (the platform DPA covers the ERP side).

## Troubleshooting

| Symptom | Cause → fix |
| --- | --- |
| Console Verify fails / no receipt recorded | API not reachable over HTTPS from the internet, or wrong URL — re-copy from the go-live panel (it includes your shop code). |
| 🔴 ลายเซ็นไม่ถูกต้อง (`bad_signature`) | Saved Channel secret ≠ the channel's — re-copy from Basic settings and re-save (token + secret together). |
| `WEBHOOK_UNVERIFIED` in API logs | No secret saved for this tenant while `NODE_ENV=production` — step 4. |
| Test button → `NOT_LINKED` | Your ERP user has no linked LINE — Requisitions → เชื่อมต่อ LINE → `link <code>`. |
| Pushes "sent" but nothing arrives | Channel resolved ⚪ mock (no tenant creds and no env token) — the badge tells you; save creds. |
| Chat replies duplicated by canned text | OA auto-reply still on — step 2. |

## Revision history

| Version | Date | Change |
| --- | --- | --- |
| v1.0 | 2026-07-03 | Initial runbook (LP-1, docs/31). |

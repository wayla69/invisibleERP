# 12 · Platform Customization

**Status: DRAFT v0.5** · Updated 2026-06-24 — added the AI-native features (copilot, document AI, NL analytics, AI config assistant, controls monitoring).

This chapter is the **map** to the no-code ways you can adapt the system to your
business — for **Admins**, *AccessAdmin*, *MasterDataAdmin* and *Executives*. Each
feature has a fuller guide elsewhere; this page tells you what exists, who can use
it, and where to find it. **Everything here is private to your company** and **none
of it touches the accounting ledger** — these are configuration and convenience
tools.

---

## At a glance

| You want to… | Feature | Screen | Permission | Full guide |
|---|---|---|---|---|
| Add your own fields to records | **Custom fields** | `/custom-fields` | masterdata / users / exec | [Administration §9](./11-administration.md) |
| Route approvals with levels, SLA & escalation | **Approval workflows** | `/workflow` | exec / users | [Approvals §4](./10-approvals.md) |
| Get notified when a threshold is crossed | **Alert rules** | `/alerts` | masterdata / users / exec / dashboard | [Administration §10](./11-administration.md) |
| Have reports built & emailed on a schedule | **Scheduled reports** | `/scheduled-reports` | exec | [Reports §7](./09-reports-and-analytics.md) |
| Reuse your list filters | **Saved views** | `/saved-views` | any list screen | [Reports §8](./09-reports-and-analytics.md) |
| Choose the KPIs each role sees | **Role dashboards** | `/dashboard-designer` | users / exec | [Reports §1a](./09-reports-and-analytics.md) |
| Review who changed what, and export it | **Audit trail** | `/audit` | users | [Administration §11](./11-administration.md) |
| Load many records from a spreadsheet (with a preview) | **Bulk import** | `/master-data` | masterdata | [Administration §8](./11-administration.md) |
| Push events to other systems | **Webhooks** | `/webhooks` | users | [Administration §12](./11-administration.md) |
| Put your logo & tagline on receipts | **Branding** | `/setup` | users | [Administration §13](./11-administration.md) |
| Customize how documents look (receipt, …) | **Document templates** | `/document-templates` | users / exec | [Administration §14](./11-administration.md) |
| Create your own record types (no code) | **Custom objects** | `/custom-objects` | masterdata / users / exec | [Administration §15](./11-administration.md) |
| Lay out a custom object's form | **Form layouts** | `/object-layouts` | masterdata / users / exec | [Administration §16](./11-administration.md) |
| Automate actions when events happen | **Automation** | `/automation` | masterdata / users / exec | [Administration §17](./11-administration.md) |
| Build your own reports (no code) | **Analytics studio** | `/query` | exec / dashboard / masterdata | [Reports §9](./09-reports-and-analytics.md) |
| Ask the AI copilot (cited answers) | **Copilot** | `/copilot` | ai_chat / dashboard | [Reports §9](./09-reports-and-analytics.md) |
| Read an invoice into an AP draft | **Document AI** | `/doc-ai` | procurement / creditors / exec | [Procurement §3](./03-procurement.md) |
| Ask for data in plain language | **NL Analytics** | `/nl-analytics` | exec / dashboard / masterdata | [Reports §9](./09-reports-and-analytics.md) |
| Draft a config from a description | **AI Config** | `/ai-config` | masterdata / users / exec | [Administration §17](./11-administration.md) |
| Scan the books for red flags | **Controls monitoring** | `/controls` | exec / users / creditors | [Administration §11](./11-administration.md) |
| Use the system in your language | **Language picker** | header (top-right) | anyone (your own) | [Getting started](./00-getting-started.md) |
| Brand the whole app (colours, logo) | **White-label theme** | `/theme` | users / exec | [Administration §13](./11-administration.md) |
| Get set up step by step + install a starter pack | **Onboarding** | `/onboarding` | users / exec / dashboard | [Getting started](./00-getting-started.md) |
| Manage API keys, rate tiers & OpenAPI | **Developer portal** | `/developer` | users | [Administration §12](./11-administration.md) |
| Connect LINE / Shopee / import bank statements | **Connectors** | `/connectors` | users / exec | [Administration §12](./11-administration.md) |
| Bring data in from another system | **Migration** | `/migration` | masterdata / users / exec | [Administration §8](./11-administration.md) |
| Set up for your country (CoA / tax / locale) | **Localization** | `/localization` | exec / users / masterdata | [Administration](./11-administration.md) |
| Send e-tax invoices to the authority | **e-Invoicing** | `/einvoice` | exec / creditors / ar | [Tax §7](./07-tax.md) |
| Read alerts, report deliveries & approval reminders | **Notification inbox** | `/notifications` | anyone (your own) | §A below |
| Let another system read your data securely | **Public REST API** | `/api/v1` (+ API keys) | users (to issue keys) | §B below |
| Let staff sign in with your company login / auto-manage users | **SSO & SCIM** | Settings → SSO / SCIM | users | §C below |

---

## A · Your notification inbox

Everything the system needs to tell you — a low-stock **alert**, a **scheduled report**
that just arrived, an **approval that's overdue** — lands in your personal inbox.

- **Where:** the **bell icon** (🔔) at the top-right of every screen. A red number on
  the bell is your count of **unread** messages. Click it for the latest few, or click
  **"ดูทั้งหมด" (See all)** to open the full inbox at `/notifications`.
- **Who:** **everyone** has an inbox. There's nothing to switch on. You only ever see
  messages addressed to **your company and your role** (plus company-wide announcements);
  one teammate reading a message never marks it read for you — read state is **per person**.
- **What you can do:**
  - **Mark one read** — click a message (in the bell list) or its **"อ่านแล้ว" (Mark read)**
    button (in the full page). The unread count drops immediately.
  - **อ่านทั้งหมด (Mark all read)** — clears your badge in one click.
  - **เฉพาะที่ยังไม่อ่าน (Unread only)** — on the full page, filter to just what you
    haven't read yet.
- **Note:** the inbox **never** shows another company's or another role's messages, and it
  contains **notifications only** — it never changes any accounting record.

---

## B · The public API (for connecting other systems)

If you use another system (an online shop, a BI tool, your own software) that needs to
**read** your data, it can connect to the **Public API** instead of a person logging in.

- **Issue an API key.** An admin with the *users* permission creates a key in
  **Administration → API keys** (`/api/platform/api-keys`). Choose what the key may do by
  giving it **scopes** — e.g. `catalog:read`, `inventory:read`, `orders:read`,
  `invoices:read` (or `read` for all reads, or `*` for everything). The **full key is shown
  only once** (it starts `ierp_…`) — copy it then; you can't see it again.
- **Hand it to the other system.** It calls the API at `https://<your-server>/api/v1/…`
  sending the key as `Authorization: Bearer ierp_…`. Available endpoints: `/api/v1/items`,
  `/api/v1/inventory`, `/api/v1/orders`, `/api/v1/invoices` (and `/api/v1/me` to check the
  key). The machine-readable manual is at **`/api/v1/openapi.json`**.
- **It only ever sees your company's data**, and only what the key's scopes allow — a key
  without `orders:read` is refused the orders endpoint. Calls are **rate-limited** per key;
  too many too fast get a polite "try again later" (`429`).
- **Revoke any time.** Delete the key in the same screen and it stops working immediately.
- **Note:** the public API is **read-only** and **never** posts to the ledger. Keep keys
  secret — anyone holding one can read what its scopes allow.

---

## C · Single sign-on (SSO) & automatic user management (SCIM)

Large organisations can let staff sign in with their **company login** (Microsoft/Azure AD,
Okta, Google) and have user accounts **created and switched off automatically** when people join
or leave — no manual account admin.

**Set it up** (an admin with the *users* permission, in **Settings → SSO / SCIM**):

1. **SSO (single sign-on).** Tick *Enable SSO* and fill in the details your IdP gives you:
   *Issuer URL*, *Client ID*, *Client Secret*, *Redirect URI* (`https://<your-app>/sso/callback`),
   and the *default role* new staff should get. Save. The **client secret is stored encrypted**
   and never shown again.
2. **SCIM (auto user management).** Press **Generate SCIM token** and paste the token
   (shown **once**) into your IdP's provisioning settings, pointing it at `/scim/v2`. Your IdP can
   then add users, change their role, and **deactivate** leavers automatically.

**How staff log in:** on the login page they click **“เข้าสู่ระบบด้วย SSO”**, enter your
**company code**, and are sent to your IdP. First-time users are created automatically with the
default role.

- **Note (security & control):**
  - A new SSO user still respects **segregation of duties** — the system creates them through the
    same checks as manual user creation.
  - **Deactivating** a user (via your IdP/SCIM) does **not** delete them — it switches the account
    off, so the audit history is kept. A deactivated person **cannot log in** by any method.
  - **Everything is scoped to your company** — your IdP/SCIM can only see and manage your own
    organisation's users.

---

## How these fit together

- **You only see what your permission allows.** Each tool above is gated, and —
  for things like role dashboards — even a configured layout is filtered down to
  what each individual viewer is allowed to see.
- **Your data stays yours.** Every setting and its results are scoped to your
  company; one company can never see or change another's configuration.
- **Nothing posts to the ledger.** These features automate, notify, validate,
  brand and integrate — they never create accounting entries. Financial postings
  always go through the normal, controlled cycles.
- **Everything is recorded.** Each change you make is written to the tamper-proof
  **Audit trail** (`/audit`), so there's always a record of who configured what.

---

## A note on automation timing

Three of these run on a **schedule** (and can also be triggered on demand):

- **Alert rules** evaluate your live data and notify the right people.
- **Scheduled reports** build and deliver your chosen reports.
- **Webhooks** deliver signed event messages to the systems you connect, with
  automatic retries for anything that doesn't get through.

You can always press the relevant **“run now / send now / dispatch”** button to
act immediately rather than wait for the next cycle.

---

**Next:** [Administration](./11-administration.md) ·
[Reports & Analytics](./09-reports-and-analytics.md) ·
[Approvals](./10-approvals.md)

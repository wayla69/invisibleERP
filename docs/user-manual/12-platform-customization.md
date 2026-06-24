# 12 · Platform Customization

**Status: DRAFT v0.1**

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

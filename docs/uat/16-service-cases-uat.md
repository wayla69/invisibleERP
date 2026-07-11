# UAT — Service Cloud: Support Cases & Email-to-Case (SVC-4)

**Status: DRAFT v0.1 · 2026-07-11** · Cross-ref: process narrative `32-after-sales-warranty.md` §10b (SVC-04),
harness `tools/cutover/src/service.ts` (SVC-4 checks), user manual `docs/user-manual/16-crm-workspace.md` §16.10.

Covers the SVC-4 Support-Case object (governed status lifecycle new→open→pending→resolved→closed, reopen; priority
P1–P4; assignee; optional CRM contact link) and the **Email-to-Case** intake (control **SVC-04**): a public,
HMAC-authenticated webhook that threads a customer email onto its case (per-case thread token → the sender's open
case) or opens a new case so **no inbound customer email is dropped**, deduped per tenant on the provider
Message-ID. Authenticated endpoints are under `/api/service/cases/*` (gated `exec`/`marketing`); the webhook is
`POST /api/service/email-to-case/inbound/:tenantCode`. All rows are RLS tenant-scoped. Result legend: `Pass` /
`Fail` / `Blocked` / `N/A` / `Not Run` (default).

| Test ID | Scenario | Role | Preconditions | Test steps | Test data | Expected result | Priority | Type | Traceability | Result | Notes |
|---|---|---|---|---|---|---|---|---|---|---|---|
| UAT-CASE-001 | Open a case manually | Service Agent | `exec`/`marketing` duty | 1. `POST /api/service/cases` | `{subject:'Login broken', priority:'P2', contact_email:'bob@acme.com'}` | 201; `case_no='CASE-00001'`, `status='new'`, thread token minted | High | Positive | SVC-04; 32 §10b | Not Run | |
| UAT-CASE-002 | Assign a case → open | Service Agent | Case `CASE-00001` is new | 1. `POST …/cases/:id/assign` | `{assignee:'agent1'}` | 200; `status='open'`, `assignee='agent1'` | High | Positive | SVC-04; 32 §10b | Not Run | |
| UAT-CASE-003 | Resolve a case | Service Agent | Case is open | 1. `POST …/cases/:id/resolve` | `{note:'Reset password'}` | 200; `status='resolved'`, `resolved_at` set | High | Positive | SVC-04; 32 §10b | Not Run | |
| UAT-CASE-004 | Reopen a resolved case | Service Agent | Case is resolved | 1. `POST …/cases/:id/reopen` | — | 200; `status='open'` | Med | Positive | SVC-04; 32 §10b | Not Run | |
| UAT-CASE-005 | Close a case (terminal) | Service Agent | Case is open | 1. `POST …/cases/:id/close` | — | 200; `status='closed'`, `closed_at` set | High | Positive | SVC-04; 32 §10b | Not Run | |
| UAT-CASE-006 | Illegal transition rejected | Service Agent | Case is closed | 1. `POST …/cases/:id/resolve` | — | 400 `CASE_NOT_ACTIVE` | High | Control | SVC-04; 32 §10b | Not Run | Governed lifecycle |
| UAT-CASE-007 | Email-to-Case: unmatched email opens a NEW case | System (webhook) | Valid tenant code + secret | 1. `POST …/email-to-case/inbound/HQ` (no matching case) | `{from:'carol@acme.com', subject:'Cannot print', text:'…', message_id:'msg-1'}` | 201; `created=true`, `case_no='CASE-00002'`, `source='email'` | High | Control | SVC-04; 32 §10b | Not Run | Completeness — no dropped email |
| UAT-CASE-008 | New email case has a thread token + logged inbound message | Service Agent | Case from UAT-CASE-007 | 1. `GET …/cases/:id` | — | 200; `case.thread_token` present, 1 inbound `case_email_messages` row | Med | Positive | SVC-04; 32 §10b | Not Run | |
| UAT-CASE-009 | Reply with the thread token threads onto the SAME case | System (webhook) | Case has a thread token | 1. `POST …/inbound/HQ` with `[case:<token>]` in the subject | `{from:'anyone@x.com', subject:'Re: … [case:svct_…]', message_id:'msg-2'}` | 200/201; `created=false`, same `case_no`, `matched_by='thread_token'` | High | Control | SVC-04; 32 §10b | Not Run | Address-independent threading |
| UAT-CASE-010 | Redelivered Message-ID is idempotent | System (webhook) | `msg-2` already processed | 1. `POST …/inbound/HQ` re-sending `message_id:'msg-2'` | `{message_id:'msg-2'}` | `skipped='duplicate'`; no second message logged | Med | Control | SVC-04; 32 §10b | Not Run | |
| UAT-CASE-011 | Reply from the original sender (no token) threads onto their open case | System (webhook) | Sender has an open case | 1. `POST …/inbound/HQ` from the original sender, no token | `{from:'carol@acme.com', message_id:'msg-3'}` | `created=false`, same `case_no`, `matched_by='contact_email'` | Med | Control | SVC-04; 32 §10b | Not Run | |
| UAT-CASE-012 | Reply onto a resolved case reopens it | System (webhook) | Case resolved, has a token | 1. Resolve the case; 2. `POST …/inbound/HQ` with the token | `{message_id:'msg-4'}` | Case `status='open'` again | Med | Control | SVC-04; 32 §10b | Not Run | |
| UAT-CASE-013 | Unknown tenant code rejected | System (webhook) | — | 1. `POST …/email-to-case/inbound/NOPE` | `{from:'x@y.com', message_id:'m-x'}` | 401 `UNKNOWN_TENANT` | High | Control | SVC-04; 32 §10b | Not Run | |
| UAT-CASE-014 | Webhook auth: bad secret / stale timestamp rejected | System (webhook) | Tenant has an HMAC secret configured | 1. `POST …/inbound/HQ` with a wrong signature; 2. with a stale timestamp | — | 1) 401 `BAD_INBOUND_SECRET`; 2) 401 `WEBHOOK_STALE` | High | Control | SVC-04; 32 §10b | Not Run | Forgery / replay defence |
| UAT-CASE-015 | RLS tenant isolation | Admin (T1) | HQ cases exist | 1. `GET …/cases` as a second-tenant user | — | 200; `count=0` (no cross-tenant disclosure) | High | Control | SVC-04; 32 §10b | Not Run | |

## Revision history

| Version | Date | Author | Summary |
|---|---|---|---|
| 0.1 DRAFT | 2026-07-11 | `<<author>>` | Initial UAT — SVC-4 Support Cases + Email-to-Case (control SVC-04, migration 0348): manual case lifecycle (open/assign/resolve/reopen/close + illegal-transition reject), Email-to-Case new-case-on-unmatched, thread-token + contact-email threading, Message-ID idempotency, reopen-on-reply, unknown-tenant + webhook-auth rejects, and RLS isolation. Traced to `tools/cutover/src/service.ts` SVC-4 checks. |

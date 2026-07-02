# Ops runbook — activating REAL Apple/Google wallet passes (`WALLET_*` creds)

> **Audience:** platform ops / IT admin · **Feature:** docs/29 V5 (`modules/wallet-pass`, PR #326)
> **Current state without creds:** the **mock** provider issues a deterministic pass payload + a fake
> install link (`https://wallet-pass.invalid/install/…`) — nothing leaves the building. Setting the creds
> below flips the SAME code to real passes; no deploy-time flag, no code change (creds are read at call
> time, like SMS/LINE).

## 0. How resolution works (what you are configuring)

Per platform, the provider resolves in this order — first complete identity wins:

1. **Per-tenant creds** — `tenant_messaging_config` rows, channels `wallet-apple` / `wallet-google`
   (AES-256-GCM encrypted at rest, write-only; same posture as messaging creds). Use when shops bring
   their own Apple team / Google issuer.
2. **Platform env** — the `WALLET_*` variables below (one identity for every tenant).
3. **Mock** — anything missing ⇒ the platform stays in mock. `provider` on the issue response / staff view
   (`GET /api/loyalty/members/:id/wallet-pass`) tells you which one actually ran.

"Complete identity" means: Apple → `certP12` + `teamId` + `passTypeId`; Google → `saEmail` + `saKey` + `issuerId`.

## 1. Apple Wallet (PKPass)

**Prerequisite:** a paid Apple Developer Program account (organization).

1. **Pass Type ID** — [developer.apple.com](https://developer.apple.com/account) → *Certificates, Identifiers & Profiles* →
   *Identifiers* → **+** → *Pass Type IDs* → e.g. `pass.co.th.oshinei.member`. Note your **Team ID** (top-right of the account page).
2. **Signing certificate** — select the Pass Type ID → *Create Certificate* → upload a CSR
   (`openssl req -new -newkey rsa:2048 -nodes -keyout pass.key -out pass.csr`) → download `pass.cer` →
   bundle to `.p12`:
   `openssl x509 -inform DER -in pass.cer -out pass.pem && openssl pkcs12 -export -out pass.p12 -inkey pass.key -in pass.pem`
   (choose a strong export password).
3. **WWDR intermediate** — download *Apple Worldwide Developer Relations G4* from
   [Apple PKI](https://www.apple.com/certificateauthority/) and convert to PEM:
   `openssl x509 -inform DER -in AppleWWDRCAG4.cer -out wwdr.pem`.
4. **Set the env** (or per-tenant creds `{certP12, certPassword, wwdr, teamId, passTypeId}`):

   | Variable | Value |
   |---|---|
   | `WALLET_APPLE_CERT_P12` | `base64 -w0 pass.p12` |
   | `WALLET_APPLE_CERT_PASSWORD` | the .p12 export password |
   | `WALLET_APPLE_WWDR` | contents of `wwdr.pem` |
   | `WALLET_APPLE_TEAM_ID` | e.g. `A1B2C3D4E5` |
   | `WALLET_APPLE_PASS_TYPE_ID` | e.g. `pass.co.th.oshinei.member` |

> **⚠️ Honest scope note:** with creds set, the API returns the complete PassKit `pass.json` content with
> `provider: 'apple'` and `install_url: null` — **assembling and PKCS#7-signing the downloadable `.pkpass`
> bundle is a small follow-up** to build once the certs exist (it needs the real .p12 to be testable at
> all; node's crypto has no PKCS#7, so it will shell to `openssl smime` or add a signing dependency).
> Do not announce Apple passes to members until that delivery endpoint ships. Google needs no such step.

## 2. Google Wallet (loyalty objects)

1. **Issuer account** — [Google Pay & Wallet Console](https://pay.google.com/business/console) → *Google Wallet API* →
   request access → note the **Issuer ID** (numeric).
2. **Service account** — Google Cloud Console → create a service account (e.g. `wallet-pass@<project>.iam.gserviceaccount.com`) →
   *Keys* → new **JSON** key. In the Wallet console, add that service-account email as a user on the issuer account.
3. **Loyalty class** — the code references class `<issuerId>.member-card`; create it once (Wallet console → *Loyalty* → new class,
   id `member-card`) with the shop branding.
4. **Set the env** (or per-tenant creds `{saEmail, saKey, issuerId}`):

   | Variable | Value |
   |---|---|
   | `WALLET_GOOGLE_SA_EMAIL` | the service-account email |
   | `WALLET_GOOGLE_SA_KEY` | the `private_key` from the JSON key (keep the `\n` escapes) |
   | `WALLET_GOOGLE_ISSUER_ID` | the numeric issuer id |

   With these set, `POST /api/member/wallet-pass {platform:'google'}` returns a real
   `https://pay.google.com/gp/v/save/<RS256 JWT>` link — tapping it in any browser adds the card.

## 3. Verify activation (5 minutes)

1. `POST /api/member/wallet-pass` (any test member, per platform) → response `provider` should read
   `apple`/`google`, **not** `mock`.
2. Google: open the `install_url` on a phone → card appears in Google Wallet with code/tier/points.
3. Earn a point on that member → staff `GET /api/loyalty/members/:id/wallet-pass` shows `updates_count`
   bumped and `last_points` = the new balance.
4. PDPA spot-check: the pass payload contains shop, member_code, name, tier, points — nothing else.

## 4. Rotation, revocation, incidents

- **Apple cert expires yearly.** Calendar it: re-issue the certificate on the same Pass Type ID ~30 days
  early, re-export the .p12, replace `WALLET_APPLE_CERT_P12`/`_PASSWORD` (no restart needed — creds are
  read per call). Existing installed passes keep working; only new signing needs the fresh cert.
- **Google SA key rotation:** create a second key, swap `WALLET_GOOGLE_SA_KEY`, delete the old key in
  Cloud Console. Compromised key ⇒ delete it in Cloud Console immediately (issued Save-links stop working;
  re-issue passes after swapping).
- **Never commit any of these values.** Env via the deployment secret store; per-tenant via the settings
  API only (stored AES-GCM, write-only — `GET` never returns secrets).

## 5. Troubleshooting

| Symptom | Cause / fix |
|---|---|
| `provider` stays `mock` | The platform's identity is incomplete — check the three required fields for that platform (see §0). Per-tenant rows must also have `enabled=true`. |
| Google `install_url: null` with `provider:'google'` | The SA key didn't parse/sign (bad PEM, missing `\n` escapes). Fix `WALLET_GOOGLE_SA_KEY`; the object payload still returns, so nothing else breaks. |
| Google link 404s / "class not found" | The `member-card` loyalty class wasn't created under your issuer (see §2.3). |
| Apple `install_url: null` | Expected today — see the §1 scope note (.pkpass delivery endpoint is the certs-gated follow-up). |
| Pass points stale | The updates ride the BiLive tick (best-effort). Check `updates_count` on the staff view; a re-issue (`POST /api/member/wallet-pass`) always refreshes the snapshot. |

## Revision history

| Ver | Date | Author | Change |
|---|---|---|---|
| 1.0 | 2026-07-02 | Platform | Initial runbook: Apple Pass Type ID/.p12/WWDR + Google issuer/SA/class setup, resolution order (tenant → env → mock), verification, rotation, troubleshooting; honest scope note on the Apple .pkpass delivery follow-up. |

// V5 (docs/29) — wallet-pass providers (Apple Wallet / Google Wallet), mirroring the messaging-gateway
// resolver: per-tenant creds win over the platform env, and with neither present the provider is a
// deterministic MOCK (payload + fake install URL — fully harness-testable, nothing leaves the building).
// Real activation is an ops act, not a code change: Apple needs the pass-type signing cert
// (WALLET_APPLE_CERT_P12 base64 + password, WWDR, team + passType ids) and Google a Wallet-API service
// account (WALLET_GOOGLE_SA_EMAIL / _SA_KEY PEM / _ISSUER_ID) — same env-activated posture SMS/LINE had
// before their credentials existed.
//
// PDPA (the LYL-19 resolve-payload discipline): a pass carries shop, member_code, name, tier, points —
// NOTHING else. No phone, no birthday, no spend history ever enters a pass payload.
import { createSign } from 'node:crypto';

export type WalletPlatform = 'apple' | 'google';
export interface WalletPassFields { shop: string; member_code: string; name: string | null; tier: string; points: number }
export interface IssuedPass {
  provider: 'apple' | 'google' | 'mock';
  platform: WalletPlatform;
  serial: string;
  // Where the member installs the pass. Google: the signed "Save to Google Wallet" link. Mock: a
  // deterministic fake. Apple: null — the signed .pkpass bundle is assembled and served at delivery time
  // with the .p12 (an ops prerequisite; the pass.json below is the complete unsigned content).
  install_url: string | null;
  pass: Record<string, unknown>;
}

// Merge per-tenant creds over the platform env (read at call time so a late-injected secret needs no restart).
function mergeCreds(platform: WalletPlatform, creds?: Record<string, unknown> | null) {
  const e = process.env; const c = (creds ?? {}) as Record<string, string | undefined>;
  if (platform === 'apple') {
    return {
      certP12: c.certP12 ?? e.WALLET_APPLE_CERT_P12, certPassword: c.certPassword ?? e.WALLET_APPLE_CERT_PASSWORD,
      wwdr: c.wwdr ?? e.WALLET_APPLE_WWDR, teamId: c.teamId ?? e.WALLET_APPLE_TEAM_ID,
      passTypeId: c.passTypeId ?? e.WALLET_APPLE_PASS_TYPE_ID,
    };
  }
  return { saEmail: c.saEmail ?? e.WALLET_GOOGLE_SA_EMAIL, saKey: c.saKey ?? e.WALLET_GOOGLE_SA_KEY, issuerId: c.issuerId ?? e.WALLET_GOOGLE_ISSUER_ID };
}

// A platform is "configured" iff its signing identity is complete; otherwise the mock issues the pass.
export function resolveWalletPassProvider(platform: WalletPlatform, creds?: Record<string, unknown> | null) {
  const c = mergeCreds(platform, creds);
  const configured = platform === 'apple'
    ? !!((c as { certP12?: string }).certP12 && (c as { teamId?: string }).teamId && (c as { passTypeId?: string }).passTypeId)
    : !!((c as { saEmail?: string }).saEmail && (c as { saKey?: string }).saKey && (c as { issuerId?: string }).issuerId);
  const provider: 'apple' | 'google' | 'mock' = configured ? platform : 'mock';
  return {
    provider,
    issue(serial: string, fields: WalletPassFields): IssuedPass {
      if (provider === 'apple') return issueApple(serial, fields, c as { teamId?: string; passTypeId?: string });
      if (provider === 'google') return issueGoogle(serial, fields, c as { saEmail?: string; saKey?: string; issuerId?: string });
      // Mock — deterministic payload + fake install URL (never a real host; .invalid is RFC-reserved).
      return { provider: 'mock', platform, serial, install_url: `https://wallet-pass.invalid/install/${serial}`, pass: passContent(serial, fields) };
    },
  };
}

// The PDPA-minimal pass content every provider shares (and the mock returns verbatim).
function passContent(serial: string, f: WalletPassFields): Record<string, unknown> {
  return { serial, shop: f.shop, member_code: f.member_code, name: f.name, tier: f.tier, points: f.points, barcode: f.member_code };
}

// Apple PassKit pass.json (storeCard). Signing into the .pkpass zip requires the .p12 + WWDR at the
// delivery endpoint — that step is ops-gated; this returns the complete unsigned pass content.
function issueApple(serial: string, f: WalletPassFields, c: { teamId?: string; passTypeId?: string }): IssuedPass {
  const pass = {
    formatVersion: 1, passTypeIdentifier: c.passTypeId, teamIdentifier: c.teamId, serialNumber: serial,
    organizationName: f.shop, description: `${f.shop} member card`,
    storeCard: {
      primaryFields: [{ key: 'points', label: 'แต้ม', value: f.points }],
      secondaryFields: [{ key: 'tier', label: 'ระดับ', value: f.tier }, { key: 'member', label: 'สมาชิก', value: f.name ?? f.member_code }],
    },
    barcodes: [{ format: 'PKBarcodeFormatQR', message: f.member_code, messageEncoding: 'iso-8859-1' }],
  };
  return { provider: 'apple', platform: 'apple', serial, install_url: null, pass };
}

// Google Wallet loyaltyObject + RS256-signed "Save to Google Wallet" JWT (node:crypto — no SDK needed).
function issueGoogle(serial: string, f: WalletPassFields, c: { saEmail?: string; saKey?: string; issuerId?: string }): IssuedPass {
  const objectId = `${c.issuerId}.${serial}`;
  const obj = {
    id: objectId, classId: `${c.issuerId}.member-card`, state: 'ACTIVE',
    accountId: f.member_code, accountName: f.name ?? f.member_code,
    loyaltyPoints: { label: 'แต้ม', balance: { int: Math.round(f.points) } },
    secondaryLoyaltyPoints: { label: 'ระดับ', balance: { string: f.tier } },
    barcode: { type: 'QR_CODE', value: f.member_code },
  };
  const jwt = signGoogleSaveJwt(c, obj);
  return { provider: 'google', platform: 'google', serial, install_url: jwt ? `https://pay.google.com/gp/v/save/${jwt}` : null, pass: obj };
}

const b64url = (s: string) => Buffer.from(s).toString('base64url');
function signGoogleSaveJwt(c: { saEmail?: string; saKey?: string }, loyaltyObject: Record<string, unknown>): string | null {
  try {
    const header = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
    const claims = b64url(JSON.stringify({
      iss: c.saEmail, aud: 'google', typ: 'savetowallet', iat: Math.floor(Date.now() / 1000),
      payload: { loyaltyObjects: [loyaltyObject] },
    }));
    const signer = createSign('RSA-SHA256');
    signer.update(`${header}.${claims}`);
    const sig = signer.sign(String(c.saKey).replace(/\\n/g, '\n')).toString('base64url');
    return `${header}.${claims}.${sig}`;
  } catch {
    return null; // bad key → no save-link; the object payload is still returned (never throw at issue time)
  }
}

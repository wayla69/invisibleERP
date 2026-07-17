import { z } from 'zod';
import { ROLES } from './enums.js';

// Shared Zod contracts — single source of truth for REST DTOs and (later) AI tool input schemas.

export const LoginRequest = z.object({
  username: z.string().min(1),
  password: z.string().min(1),
  totp: z.string().optional(), // 6-digit TOTP code — required when the account has MFA enabled (ITGC-AC-06)
});
export type LoginRequest = z.infer<typeof LoginRequest>;

export const LoginResponse = z.object({
  token: z.string(),
  username: z.string(),
  role: z.enum(ROLES),
  customer_name: z.string().nullable(),
  must_change_password: z.boolean().optional(),
  must_setup_mfa: z.boolean().optional(), // privileged/finance role without MFA enrolled — client must force setup
});
export type LoginResponse = z.infer<typeof LoginResponse>;

// POS-PIN quick-login (ITGC-AC-17) — username + 4–6 digit PIN. Front-of-house only; privileged/MFA roles
// are rejected at the service layer. PIN shares the ITGC-AC-07 per-account lockout with password login.
const PIN_REGEX = /^\d{4,6}$/;
export const PinLoginRequest = z.object({
  username: z.string().min(1),
  pin: z.string().regex(PIN_REGEX),
});
export type PinLoginRequest = z.infer<typeof PinLoginRequest>;

// PIN login also returns the resolved permissions so the client can decide, in one round-trip, whether to
// chain "open shift" (needs pos_till) for the combined "เข้าสู่ระบบ / เปิดกะ" front-of-house flow.
export const PinLoginResponse = LoginResponse.extend({ permissions: z.array(z.string()) });
export type PinLoginResponse = z.infer<typeof PinLoginResponse>;

// Self-service: set/rotate your own PIN — gated by re-entering the current password (step-up).
export const SetOwnPinRequest = z.object({
  current_password: z.string().min(1),
  pin: z.string().regex(PIN_REGEX),
});
export type SetOwnPinRequest = z.infer<typeof SetOwnPinRequest>;

// Admin (access-admin / 'users' permission): set a staff member's PIN.
export const SetPinRequest = z.object({ pin: z.string().regex(PIN_REGEX) });
export type SetPinRequest = z.infer<typeof SetPinRequest>;

export const AuthUser = z.object({
  username: z.string(),
  role: z.enum(ROLES),
  customer_name: z.string().nullable(),
  permissions: z.array(z.string()),
  // Display name of the active company (tenants.name) — customer_name above is only the tenant CODE.
  // The web sidebar header shows it so users always know which company they're signed into.
  company_name: z.string().nullable().optional(),
  must_change_password: z.boolean().optional(),
  // True when this account is a configured platform owner ("god", PLATFORM_ADMIN_USERNAMES) — the web uses
  // it to show the cross-company switcher. Server-derived from env; never a client-settable claim.
  is_platform_owner: z.boolean().optional(),
  // SME single-user edition (docs/49) — the tenant's control profile, resolved live from the DB (never a
  // claim). Drives the persistent "โหมด SME" badge; absent/'enterprise' shows nothing.
  control_profile: z.enum(['enterprise', 'sme']).optional(),
  // Nav group title keys hidden for this SME tenant (from tenants.sme_prefs, stamped at provisioning).
  sme_hidden_nav_groups: z.array(z.string()).optional(),
  // B1 (docs/50): group/subgroup title keys that default OPEN in the sidebar for this SME tenant —
  // the industry-derived nav profile stamped into tenants.sme_prefs at provisioning. A user's own
  // synced navFold toggle always overrides; absent/empty keeps the only-active-open default.
  sme_open_nav_groups: z.array(z.string()).optional(),
});
export type AuthUser = z.infer<typeof AuthUser>;

// Inventory stock query (legacy GET /api/inventory/stock)
export const StockQuery = z.object({
  search: z.string().optional(),
  low_only: z.coerce.boolean().default(false),
  limit: z.coerce.number().int().positive().max(500).default(50),
});
export type StockQuery = z.infer<typeof StockQuery>;

// Standard error envelope
export const ErrorEnvelope = z.object({
  error: z.object({
    code: z.string(),
    message: z.string(),
    messageTh: z.string().optional(),
  }),
});
export type ErrorEnvelope = z.infer<typeof ErrorEnvelope>;

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

export const AuthUser = z.object({
  username: z.string(),
  role: z.enum(ROLES),
  customer_name: z.string().nullable(),
  permissions: z.array(z.string()),
  must_change_password: z.boolean().optional(),
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

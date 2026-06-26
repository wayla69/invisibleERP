import { Body, Controller, Get, Post, Param, HttpCode, Res, Req } from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { LoginRequest, type LoginResponse, type AuthUser } from '@ierp/shared';
import { Public, Permissions, CurrentUser, type JwtUser } from '../../common/decorators';
import { ZodValidationPipe } from '../../common/zod-validation.pipe';
import { setAuthCookies, clearAuthCookies, readCookie, AUTH_COOKIE } from '../../common/cookies';
import { AuthService } from './auth.service';

const ChangePasswordBody = z.object({
  current_password: z.string().min(1),
  new_password: z.string().min(8),
});
type ChangePasswordBody = z.infer<typeof ChangePasswordBody>;

const MfaCodeBody = z.object({ code: z.string().min(6) });
const MfaDisableBody = z.object({ password: z.string().min(1), code: z.string().min(6) });

@Controller('api')
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  @Post('auth/change-password')
  @HttpCode(200)
  changePassword(@Body(new ZodValidationPipe(ChangePasswordBody)) b: ChangePasswordBody, @CurrentUser() user: JwtUser) {
    return this.auth.changePassword(user.username, b.current_password, b.new_password);
  }

  // ── ITGC-AC-06: MFA enrolment (authenticated) ──
  @Get('auth/mfa/status')
  mfaStatus(@CurrentUser() user: JwtUser) { return this.auth.mfaStatus({ username: user.username, role: user.role }); }

  @Post('auth/mfa/setup')
  @HttpCode(200)
  mfaSetup(@CurrentUser() user: JwtUser) { return this.auth.mfaSetup(user.username); }

  @Post('auth/mfa/enable')
  @HttpCode(200)
  mfaEnable(@Body(new ZodValidationPipe(MfaCodeBody)) b: z.infer<typeof MfaCodeBody>, @CurrentUser() user: JwtUser) {
    return this.auth.mfaEnable(user.username, b.code);
  }

  @Post('auth/mfa/disable')
  @HttpCode(200)
  mfaDisable(@Body(new ZodValidationPipe(MfaDisableBody)) b: z.infer<typeof MfaDisableBody>, @CurrentUser() user: JwtUser) {
    return this.auth.mfaDisable(user.username, b.password, b.code);
  }

  @Public()
  @Post('login')
  @HttpCode(200) // parity: V1 FastAPI คืน 200 (ไม่ใช่ 201 default ของ Nest POST)
  async login(@Body(new ZodValidationPipe(LoginRequest)) body: LoginRequest, @Res({ passthrough: true }) reply: FastifyReply): Promise<LoginResponse> {
    const res = await this.auth.login(body.username, body.password, body.totp);
    // Set the httpOnly auth cookie (+ readable CSRF) for the browser. The token is ALSO returned in the body
    // for non-browser clients (mobile / scripts) — backward compatible.
    setAuthCookies(reply, res.token);
    return res;
  }

  // Clear the session cookies. @Public so it always succeeds (even with an expired/absent token); it only
  // ever clears the caller's own cookies.
  @Public()
  @Post('auth/logout')
  @HttpCode(200)
  async logout(@Req() req: FastifyRequest, @Res({ passthrough: true }) reply: FastifyReply): Promise<{ ok: true }> {
    // Revoke the presented token (jti denylist) so it can't be replayed before its 8h expiry, then clear cookies.
    const auth = req.headers['authorization'];
    const bearer = typeof auth === 'string' && auth.startsWith('Bearer ') ? auth.slice(7) : undefined;
    const token = bearer ?? readCookie(req, AUTH_COOKIE);
    await this.auth.revokeToken(token);
    clearAuthCookies(reply);
    return { ok: true };
  }

  // Incident-response / admin: revoke ALL of a user's sessions immediately (forces re-login everywhere).
  @Post('auth/users/:username/revoke-sessions')
  @Permissions('users')
  @HttpCode(200)
  revokeSessions(@Param('username') username: string): Promise<{ username: string; revoked_all: boolean }> {
    return this.auth.revokeAllSessions(username);
  }

  @Get('auth/me')
  me(@CurrentUser() user: JwtUser): Promise<AuthUser> {
    return this.auth.me({
      username: user.username,
      role: user.role as AuthUser['role'],
      customer_name: user.customerName,
      permissions: user.permissions,
    });
  }
}

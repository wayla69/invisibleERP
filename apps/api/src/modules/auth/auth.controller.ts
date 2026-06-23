import { Body, Controller, Get, Post, HttpCode } from '@nestjs/common';
import { z } from 'zod';
import { LoginRequest, type LoginResponse, type AuthUser } from '@ierp/shared';
import { Public, CurrentUser, type JwtUser } from '../../common/decorators';
import { ZodValidationPipe } from '../../common/zod-validation.pipe';
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
  login(@Body(new ZodValidationPipe(LoginRequest)) body: LoginRequest): Promise<LoginResponse> {
    return this.auth.login(body.username, body.password, body.totp);
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

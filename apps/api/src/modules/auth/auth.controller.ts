import { Body, Controller, Get, Post, HttpCode } from '@nestjs/common';
import { LoginRequest, type LoginResponse, type AuthUser } from '@ierp/shared';
import { Public, CurrentUser, type JwtUser } from '../../common/decorators';
import { ZodValidationPipe } from '../../common/zod-validation.pipe';
import { AuthService } from './auth.service';

@Controller('api')
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  @Public()
  @Post('login')
  @HttpCode(200) // parity: V1 FastAPI คืน 200 (ไม่ใช่ 201 default ของ Nest POST)
  login(@Body(new ZodValidationPipe(LoginRequest)) body: LoginRequest): Promise<LoginResponse> {
    return this.auth.login(body.username, body.password);
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

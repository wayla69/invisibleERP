import { CanActivate, ExecutionContext, Injectable, UnauthorizedException, ForbiddenException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';
import { IS_PUBLIC_KEY, PERMISSIONS_KEY, type JwtUser } from './decorators';

// Global guard: ทุก endpoint ต้องมี JWT ยกเว้น @Public (แก้ช่องโหว่ V1 ที่ data endpoints เปิดโล่ง)
@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(private readonly reflector: Reflector, private readonly jwt: JwtService) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [ctx.getHandler(), ctx.getClass()]);
    if (isPublic) return true;

    const req = ctx.switchToHttp().getRequest();
    const auth: string | undefined = req.headers?.authorization;
    if (!auth?.startsWith('Bearer ')) {
      throw new UnauthorizedException({ code: 'UNAUTHORIZED', message: 'Missing token', messageTh: 'ไม่พบ token' });
    }
    try {
      const payload = await this.jwt.verifyAsync(auth.slice(7));
      req.user = {
        username: payload.sub,
        role: payload.role,
        customerName: payload.customerName ?? null,
        tenantId: payload.tenantId ?? null,
        permissions: payload.permissions ?? [],
      } satisfies JwtUser;
      return true;
    } catch {
      throw new UnauthorizedException({ code: 'UNAUTHORIZED', message: 'Invalid or expired token', messageTh: 'token ไม่ถูกต้องหรือหมดอายุ' });
    }
  }
}

// ตรวจ @Permissions(...) เทียบกับ user.permissions (Admin มีครบอยู่แล้วจาก resolvePermissions)
@Injectable()
export class PermissionsGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(ctx: ExecutionContext): boolean {
    const required = this.reflector.getAllAndOverride<string[]>(PERMISSIONS_KEY, [ctx.getHandler(), ctx.getClass()]);
    if (!required || required.length === 0) return true;
    const user: JwtUser | undefined = ctx.switchToHttp().getRequest().user;
    const perms = user?.permissions ?? [];
    // ผ่านถ้ามีสิทธิ์อย่างน้อยหนึ่งใน required (ตรง logic เมนู V1 ที่โชว์ถ้ามี perm ใด ๆ)
    const ok = required.some((p) => perms.includes(p));
    if (!ok) {
      throw new ForbiddenException({ code: 'FORBIDDEN', message: `Access denied: ${required.join(',')}`, messageTh: 'คุณไม่มีสิทธิ์เข้าถึงส่วนนี้' });
    }
    return true;
  }
}

import { Controller, Get, Put, Body } from '@nestjs/common';
import { z } from 'zod';
import { Permissions, CurrentUser, type JwtUser } from '../../common/decorators';
import { ZodValidationPipe } from '../../common/zod-validation.pipe';
import { ThemeService } from './theme.service';

const ThemeBody = z.object({
  primary_hue: z.number(),
  radius: z.string().min(1),
  brand_name: z.string().optional(),
  logo_url: z.string().optional(),
  tagline: z.string().optional(),
});

// E4 (Phase 29) — white-label theming. GET is universal (every user's shell needs the effective theme);
// setting it needs an admin permission. Presentation-only; never posts to the GL.
@Controller('api/tenant/theme')
export class ThemeController {
  constructor(private readonly svc: ThemeService) {}

  @Get() get(@CurrentUser() u: JwtUser) { return this.svc.get(u); }

  @Put() @Permissions('users', 'exec')
  put(@Body(new ZodValidationPipe(ThemeBody)) b: any, @CurrentUser() u: JwtUser) { return this.svc.put(u, b); }
}

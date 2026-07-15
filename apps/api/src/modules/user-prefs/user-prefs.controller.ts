import { Controller, Get, Put, Body } from '@nestjs/common';
import { z } from 'zod';
import { UserPrefsService } from './user-prefs.service';
import { ZodValidationPipe } from '../../common/zod-validation.pipe';
import { CurrentUser } from '../../common/decorators';
import type { JwtUser } from '../../common/decorators';

// Personal UI preferences — no @Permissions: every authenticated user may read/write their OWN prefs
// (the service scopes by username, RLS by tenant). The customer portal does not call this.
const UpdateBody = z.object({
  favorites: z.array(z.string().min(1).max(200)).max(100).optional(),
  navFold: z.record(z.boolean()).optional(),
  pos_fav: z.array(z.number().int().positive()).max(200).optional(),
  shop_favs: z.array(z.string().min(1).max(200)).max(300).optional(),
  shop_templates: z.array(z.object({
    name: z.string().min(1).max(120),
    lines: z.array(z.object({
      item_id: z.string().min(1).max(200),
      description: z.string().max(500).default(''),
      uom: z.string().max(40).default(''),
      qty: z.number().positive(),
    })).max(200),
  })).max(50).optional(),
  sme_wizard_done: z.boolean().optional(), // docs/49 v1.3 — SME first-run wizard completed/dismissed
});

@Controller('api/user-prefs')
export class UserPrefsController {
  constructor(private readonly svc: UserPrefsService) {}

  @Get()
  get(@CurrentUser() user: JwtUser) {
    return this.svc.get(user);
  }

  @Put()
  update(@Body(new ZodValidationPipe(UpdateBody)) dto: z.infer<typeof UpdateBody>, @CurrentUser() user: JwtUser) {
    return this.svc.update(dto, user);
  }
}

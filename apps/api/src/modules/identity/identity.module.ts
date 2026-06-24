import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { AdminUsersModule } from '../admin-users/admin-users.module';
import { IdentityConfigService } from './identity-config.service';
import { IdentityController } from './identity.controller';
import { SsoService } from './sso.service';
import { SsoController } from './sso.controller';
import { ScimService } from './scim.service';
import { ScimController } from './scim.controller';
import { ScimAuthGuard } from './scim.guard';
import { PasswordService } from '../auth/password.service';

// Enterprise identity (Platform #4): per-tenant OIDC SSO + SCIM 2.0 provisioning.
@Module({
  imports: [AuthModule, AdminUsersModule], // JwtModule (SSO mint) + AdminUsersService (SoD-safe create)
  controllers: [IdentityController, SsoController, ScimController],
  providers: [IdentityConfigService, SsoService, ScimService, ScimAuthGuard, PasswordService],
})
export class IdentityModule {}

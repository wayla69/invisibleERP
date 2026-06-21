import { Module } from '@nestjs/common';
import { PlatformController } from './platform.controller';
import { ApiKeyService } from './api-key.service';
import { WebhookService } from './webhook.service';
import { MfaService } from './mfa.service';
import { OidcService } from './oidc.service';

@Module({
  controllers: [PlatformController],
  providers: [ApiKeyService, WebhookService, MfaService, OidcService],
  exports: [ApiKeyService, WebhookService],
})
export class PlatformModule {}

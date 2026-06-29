import { Module } from '@nestjs/common';
import { AdminUsersService } from './admin-users.service';
import { AdminUsersController } from './admin-users.controller';
import { PasswordService } from '../auth/password.service';
import { BillingModule } from '../billing/billing.module';

@Module({
  imports: [BillingModule],
  controllers: [AdminUsersController],
  providers: [AdminUsersService, PasswordService],
  exports: [AdminUsersService],
})
export class AdminUsersModule {}

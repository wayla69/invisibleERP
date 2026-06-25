import { Module } from '@nestjs/common';
import { UserPrefsService } from './user-prefs.service';
import { UserPrefsController } from './user-prefs.controller';

// Per-user UI preferences (sidebar favourites + nav fold-state), synced across devices. DRIZZLE is global.
@Module({
  controllers: [UserPrefsController],
  providers: [UserPrefsService],
  exports: [UserPrefsService],
})
export class UserPrefsModule {}

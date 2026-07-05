import { Module } from '@nestjs/common';
import { ProjectsModule } from '../projects/projects.module';
import { TendersService } from './tenders.service';
import { TendersController } from './tenders.controller';

// Tender / estimating → award (docs/35 P3, PROJ-17). Needs ProjectsService (ProjectsModule) to seed the
// project + draft BoQ on award. One-way import (Projects does not import Tenders) → no DI cycle.
// DocNumberService comes from the @Global CommonModule.
@Module({
  imports: [ProjectsModule],
  controllers: [TendersController],
  providers: [TendersService],
  exports: [TendersService],
})
export class TendersModule {}

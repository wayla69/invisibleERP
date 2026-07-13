import { Module } from '@nestjs/common';
import { FinanceModule } from '../finance/finance.module';
import { EamService } from './eam.service';
import { EamController } from './eam.controller';
import { EamBiReports } from './eam-bi-reports';

// Enterprise Asset Management (maintenance). FinanceModule supplies FinanceService so completing a work
// order can raise an AP payable for the maintenance cost. DocNumberService + DRIZZLE are global.
@Module({ imports: [FinanceModule], controllers: [EamController], providers: [EamBiReports, EamService], exports: [EamService] })
export class EamModule {}

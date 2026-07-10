import { Module } from '@nestjs/common';
import { BudgetService } from './budget.service';
import { BudgetController } from './budget.controller';
import { BudgetControlController } from './budget-control.controller';
import { CommitmentsModule } from '../commitments/commitments.module';

// Budget vs Actual — reference data + variance report read from the GL. DRIZZLE is global.
// FIN-3 (BUD-02): the budgetary-control surface (availability / commitments / policy settings) rides the
// shared CommitmentsService (one encumbrance engine for project BoQ + GL budgets — do not fork a second).
@Module({
  imports: [CommitmentsModule],
  controllers: [BudgetController, BudgetControlController],
  providers: [BudgetService],
  exports: [BudgetService],
})
export class BudgetModule {}

import { Module } from '@nestjs/common';
import { LedgerModule } from '../ledger/ledger.module';
import { DocumentTemplatesModule } from '../document-templates/document-templates.module';
import { PayrollController } from './payroll.controller';
import { PayrollService } from './payroll.service';
import { PayslipPdfService } from './payslip-pdf.service';

// Payroll (เงินเดือน) — employees, monthly run with SSO + PIT withholding, balanced GL posting, ภ.ง.ด.1.
// LedgerModule provides LedgerService for the payroll journal entry. The payslip renderer (PayslipPdfService)
// injects the @Global PdfRenderer; DocEmailService is likewise @Global (MailModule) — no import needed for
// either. PayrollService is exported so the ESS module can serve an employee's own PDPA-scoped payslip.
@Module({
  imports: [LedgerModule, DocumentTemplatesModule],
  controllers: [PayrollController],
  providers: [PayrollService, PayslipPdfService],
  exports: [PayrollService],
})
export class PayrollModule {}

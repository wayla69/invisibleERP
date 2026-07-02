import { Module } from '@nestjs/common';
import { TaxService } from './tax.service';

// Bare tax-calculation core (VAT/WHT math, filing windows). Split out so submodules that need TaxService
// (documents/) can import it without a cycle through the umbrella TaxModule (docs/28 consolidation PR #2).
@Module({ providers: [TaxService], exports: [TaxService] })
export class TaxCoreModule {}

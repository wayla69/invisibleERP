import { Controller, Get, Query } from '@nestjs/common';
import { z } from 'zod';
import { Permissions } from '../../common/decorators';
import { ZodValidationPipe } from '../../common/zod-validation.pipe';
import { TaxService } from './tax.service';

const CalcQuery = z.object({
  net: z.coerce.number(),
  country: z.string().optional(),
  currency: z.string().optional(),
  category: z.string().optional(),
  date: z.string().optional(),
});
type CalcQuery = z.infer<typeof CalcQuery>;

@Controller('api/tax')
export class TaxController {
  constructor(private readonly svc: TaxService) {}

  // GET /api/tax/calc?net=&country=&currency=&category=&date=
  @Get('calc') @Permissions('exec', 'dashboard')
  calc(@Query(new ZodValidationPipe(CalcQuery)) q: CalcQuery) {
    return this.svc.calcTax(q);
  }

  // GET /api/tax/providers — supported countries + their resolved labels
  @Get('providers') @Permissions('exec', 'dashboard')
  providers() {
    const countries = this.svc.supportedCountries();
    return {
      countries,
      providers: countries.map((country) => {
        const sample = this.svc.resolveProvider(country).calc({ net: 100 });
        return { country, label: sample.label, rate: sample.rate };
      }),
    };
  }

  // GET /api/tax/currencies — ISO-4217 catalogue with minor-unit decimals
  @Get('currencies') @Permissions('exec', 'dashboard')
  currencies() {
    return { currencies: this.svc.currencies() };
  }
}

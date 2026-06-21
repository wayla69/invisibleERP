import { PipeTransform, BadRequestException } from '@nestjs/common';
import type { ZodSchema } from 'zod';

// ใช้: @Query(new ZodValidationPipe(StockQuery)) q: StockQuery
export class ZodValidationPipe<T> implements PipeTransform {
  constructor(private readonly schema: ZodSchema<T>) {}

  transform(value: unknown): T {
    const result = this.schema.safeParse(value);
    if (!result.success) {
      throw new BadRequestException({
        code: 'VALIDATION_ERROR',
        message: result.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '),
        messageTh: 'ข้อมูลที่ส่งมาไม่ถูกต้อง',
      });
    }
    return result.data;
  }
}

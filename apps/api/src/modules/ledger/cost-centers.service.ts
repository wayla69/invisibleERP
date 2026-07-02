import { Inject, Injectable, BadRequestException } from '@nestjs/common';
import { eq, asc } from 'drizzle-orm';
import { DRIZZLE, type DrizzleDb } from '../../database/database.module';
import { costCenters } from '../../database/schema';
import type { JwtUser } from '../../common/decorators';

export interface CostCenterDto { code: string; name: string; type?: 'department' | 'branch' | 'project'; parent_code?: string | null }

@Injectable()
export class CostCentersService {
  constructor(@Inject(DRIZZLE) private readonly db: DrizzleDb) {}

  async create(dto: CostCenterDto, user: JwtUser) {
    const db = this.db;
    const [c] = await db.insert(costCenters).values({ tenantId: user.tenantId ?? null, code: dto.code, name: dto.name, type: dto.type ?? 'department', parentCode: dto.parent_code ?? null, createdBy: user.username }).onConflictDoNothing().returning();
    if (!c) throw new BadRequestException({ code: 'CC_EXISTS', message: `Cost center ${dto.code} already exists`, messageTh: 'มีศูนย์ต้นทุนนี้แล้ว' });
    return shape(c);
  }

  async list(_user: JwtUser) {
    const db = this.db;
    const rows = await db.select().from(costCenters).orderBy(asc(costCenters.code));
    return { cost_centers: rows.map(shape), count: rows.length };
  }
}

function shape(c: any) {
  return { id: Number(c.id), code: c.code, name: c.name, type: c.type, parent_code: c.parentCode, active: c.active };
}

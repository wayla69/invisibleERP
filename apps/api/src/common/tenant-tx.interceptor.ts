import { CallHandler, ExecutionContext, Injectable, NestInterceptor, Inject, Logger } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { from, firstValueFrom } from 'rxjs';
import { sql } from 'drizzle-orm';
import { DRIZZLE, type DrizzleDb } from '../database/database.module';
import { tenantALS } from './tenant-context';

// Wraps each (non-SSE) request in a tenant-scoped transaction:
//   SET LOCAL ROLE app_user  +  set_config('app.tenant_id'|'app.bypass_rls')
// then runs the handler inside tenantALS so the DRIZZLE proxy routes all queries to this tx.
// Customer role -> scoped to its tenant; staff/HQ/public -> bypass (sees all). RLS enforced in DB.
@Injectable()
export class TenantTxInterceptor implements NestInterceptor {
  private warnedRole = false;
  constructor(@Inject(DRIZZLE) private readonly db: DrizzleDb, private readonly reflector: Reflector) {}

  intercept(ctx: ExecutionContext, next: CallHandler) {
    if (ctx.getType() !== 'http') return next.handle();
    // do not wrap SSE/streaming endpoints in a single transaction
    const isSse = this.reflector.get<boolean>('sse', ctx.getHandler());
    if (isSse) return next.handle();

    const req = ctx.switchToHttp().getRequest();
    const user = req?.user;
    const bypass = !user || user.role !== 'Customer'; // staff/public see all; customer is scoped
    const tenantId: number | null = user?.tenantId ?? null;

    const db = this.db as any;
    return from(
      db.transaction(async (tx: any) => {
        try {
          await tx.execute(sql`SET LOCAL ROLE app_user`);
        } catch (e) {
          if (!this.warnedRole) {
            this.warnedRole = true;
            new Logger('RLS').warn('Could not SET ROLE app_user — RLS not enforced (grant membership or connect as app_user in prod).');
          }
        }
        await tx.execute(sql`select set_config('app.bypass_rls', ${bypass ? 'on' : 'off'}, true)`);
        await tx.execute(sql`select set_config('app.tenant_id', ${tenantId != null ? String(tenantId) : ''}, true)`);
        return tenantALS.run({ tx, tenantId, bypass }, () => firstValueFrom(next.handle()));
      }),
    );
  }
}

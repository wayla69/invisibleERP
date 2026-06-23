import { Controller, Get, Inject, ServiceUnavailableException } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { Public, NoTx } from '../../common/decorators';
import { DRIZZLE, type DrizzleDb } from '../../database/database.module';

// ค่าจาก config.json เดิม (Phase 1 จะย้ายไปตาราง/ConfigService)
const CONFIG = {
  company_name: 'INVISIBLE CONSULTING CO., LTD.',
  company_subtitle: 'Customer Portal for IVSB Group',
  theme_primary: '#1E3C72',
  theme_secondary: '#2A5298',
  contact_tel: '+66864989999',
  contact_email: 'kittipot.c@gmail.com',
};

@Controller()
export class HealthController {
  constructor(@Inject(DRIZZLE) private readonly db: DrizzleDb) {}

  @Public() @NoTx()
  @Get('/')
  root() {
    return { status: 'online', app: CONFIG.company_name, version: '0.1.0' };
  }

  // Liveness probe (ITGC-OP-04): cheap, no dependencies — "is the process up?". Orchestrators restart
  // the container if this fails. Kept DB-free so a DB blip doesn't trigger pointless restarts.
  @Public() @NoTx()
  @Get('healthz')
  liveness() {
    return { status: 'ok', uptime_s: Math.round(process.uptime()) };
  }

  // Readiness probe (ITGC-OP-04): "can we serve traffic?" — verifies the DB is reachable. Returns 503
  // when not, so load balancers drain this replica instead of sending it requests it would fail.
  @Public() @NoTx()
  @Get('readyz')
  async readiness() {
    try {
      await this.db.execute(sql`select 1`);
      return { status: 'ready', db: 'up' };
    } catch (e) {
      throw new ServiceUnavailableException({ status: 'not_ready', db: 'down', error: (e as Error).message });
    }
  }

  @Public() @NoTx()
  @Get('api/config')
  config() {
    return CONFIG;
  }
}

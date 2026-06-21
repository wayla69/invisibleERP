import { Controller, Get } from '@nestjs/common';
import { Public } from '../../common/decorators';

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
  @Public()
  @Get('/')
  root() {
    return { status: 'online', app: CONFIG.company_name, version: '0.1.0' };
  }

  @Public()
  @Get('api/config')
  config() {
    return CONFIG;
  }
}

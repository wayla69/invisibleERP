import { BadRequestException, Injectable } from '@nestjs/common';
import { ForecastingService } from './forecasting.service';
import { AnomaliesService } from './anomalies.service';
import { InsightsService } from './insights.service';

@Injectable()
export class AnalyticsService {
  constructor(
    private readonly forecasting: ForecastingService,
    private readonly anomalies: AnomaliesService,
    private readonly insights: InsightsService,
  ) {}

  async replenishmentList(limit = 50) {
    const items = await this.forecasting.getReplenishmentList(limit);
    return {
      items, count: items.length,
      critical: items.filter((i) => i.urgency === 'critical').length,
      warning: items.filter((i) => i.urgency === 'warning').length,
    };
  }

  async replenishmentItem(itemId: string) {
    const pred = await this.forecasting.predictStockout(itemId);
    const insight = await this.insights.replenishment(pred);
    return { ...pred, insight };
  }

  anomalySummary(days = 30) {
    return this.anomalies.getAnomalySummary(days);
  }

  async insight(type: string, data: any) {
    if (type === 'replenishment') return { insight: await this.insights.replenishment(data) };
    if (type === 'anomaly') return { insight: await this.insights.anomaly(data) };
    throw new BadRequestException({ code: 'BAD_REQUEST', message: "type must be 'replenishment' or 'anomaly'", messageTh: 'ประเภทไม่ถูกต้อง' });
  }

  async dashboardSummary() {
    const repl = await this.forecasting.getReplenishmentList(10);
    const anomaly = await this.anomalies.getAnomalySummary(7);
    const insight = await this.insights.bulk(repl, anomaly.summary);
    return {
      replenishment: { critical: repl.filter((p) => p.urgency === 'critical').length, warning: repl.filter((p) => p.urgency === 'warning').length, top_items: repl.slice(0, 3) },
      anomalies: anomaly.summary,
      insight,
    };
  }
}

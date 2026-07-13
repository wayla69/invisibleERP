import { Injectable, OnModuleInit } from '@nestjs/common';
import { DiscoveryService } from '@nestjs/core';
import { isApprovalQueueSource } from '../../common/approval-queues';
import { FinanceService } from './finance.service';

// docs/46 Phase 2 — collects module-owned GOV-01 approval queues at boot (the same discovery pattern as
// BiReportRegistrarService). Every provider (in any module) implementing ApprovalQueueSource is registered
// with FinanceService's pending-approvals aggregator, so a new maker-checker queue touches only its owning
// module — never finance.service.ts (whose size the check-service-size ratchet caps). Nest instantiates all
// providers before any onModuleInit fires, so this sees every source regardless of module init order.
@Injectable()
export class ApprovalQueueRegistrarService implements OnModuleInit {
  constructor(private readonly discovery: DiscoveryService, private readonly finance: FinanceService) {}

  onModuleInit() {
    for (const wrapper of this.discovery.getProviders()) {
      const instance = wrapper.instance;
      if (instance && isApprovalQueueSource(instance)) this.finance.registerApprovalQueues(instance);
    }
  }
}

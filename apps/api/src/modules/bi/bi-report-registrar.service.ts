import { Injectable, OnModuleInit } from '@nestjs/common';
import { DiscoveryService } from '@nestjs/core';
import { BiGenerateService } from './bi-generate.service';
import { isBiReportSource } from './report-registry';

// docs/46 Phase 1 — collects module-owned BI report generators at boot. Every provider (in any module)
// implementing BiReportSource.biReports() is discovered here and registered with BiGenerateService, so a
// new report type touches only its owning module (+ the REPORT_TYPES catalog) — never bi-generate's
// dispatcher or its constructor (whose positional order is a goldenmaster contract and whose param count
// the check-service-size ratchet caps). Nest instantiates all providers before any onModuleInit fires, so
// this sees every source regardless of module init order.
@Injectable()
export class BiReportRegistrarService implements OnModuleInit {
  constructor(private readonly discovery: DiscoveryService, private readonly generate: BiGenerateService) {}

  onModuleInit() {
    for (const wrapper of this.discovery.getProviders()) {
      const instance = wrapper.instance;
      if (instance && isBiReportSource(instance)) this.generate.registerReports(instance);
    }
  }
}

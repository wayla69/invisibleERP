import { describe, expect, it } from 'vitest';
import { evaluateHealthAlerts } from '../src/modules/jobs/health-alerts';
import { ipv4InAllowlist, platformRequireMfa } from '../src/common/guards';

const healthy = { pool: { saturation_pct: 10 }, jobs: { queued: 3, running: 1, failed: 0, stuck: 0 }, scheduler: { status: 'ok' } };

describe('evaluateHealthAlerts (wave D4)', () => {
  it('healthy metrics → no alerts', () => {
    expect(evaluateHealthAlerts(healthy, {} as NodeJS.ProcessEnv)).toEqual([]);
  });

  it('default thresholds: pool ≥80%, any failed/stuck, queued ≥500, stale scheduler', () => {
    const alerts = evaluateHealthAlerts(
      { pool: { saturation_pct: 85 }, jobs: { queued: 600, failed: 2, stuck: 1 }, scheduler: { status: 'stale' } },
      {} as NodeJS.ProcessEnv,
    );
    expect(alerts.map((a) => a.key).sort()).toEqual(['jobs_backlog', 'jobs_failed', 'jobs_stuck', 'pool_saturation', 'scheduler_stale']);
  });

  it('env overrides move the trip points', () => {
    const env = { PLATFORM_ALERT_POOL_PCT: '95', PLATFORM_ALERT_JOBS_FAILED: '10', PLATFORM_ALERT_JOBS_QUEUED: '1000', PLATFORM_ALERT_JOBS_STUCK: '5' } as unknown as NodeJS.ProcessEnv;
    expect(evaluateHealthAlerts({ pool: { saturation_pct: 90 }, jobs: { queued: 600, failed: 2, stuck: 1 }, scheduler: { status: 'ok' } }, env)).toEqual([]);
    expect(evaluateHealthAlerts({ pool: { saturation_pct: 96 }, jobs: { queued: 1000, failed: 10, stuck: 5 }, scheduler: { status: 'ok' } }, env).length).toBe(4);
  });

  it("a scheduler that has never run does not alert (only 'stale' does)", () => {
    expect(evaluateHealthAlerts({ ...healthy, scheduler: { status: 'never' } }, {} as NodeJS.ProcessEnv)).toEqual([]);
  });
});

describe('ipv4InAllowlist (wave D3)', () => {
  it('exact address and CIDR prefix match', () => {
    expect(ipv4InAllowlist('203.0.113.7', '203.0.113.7')).toBe(true);
    expect(ipv4InAllowlist('10.1.2.3', '10.0.0.0/8')).toBe(true);
    expect(ipv4InAllowlist('10.1.2.3', '10.1.2.0/24, 192.168.0.0/16')).toBe(true);
    expect(ipv4InAllowlist('11.1.2.3', '10.0.0.0/8')).toBe(false);
  });

  it('IPv4-mapped IPv6 peers match their IPv4 form', () => {
    expect(ipv4InAllowlist('::ffff:10.1.2.3', '10.0.0.0/8')).toBe(true);
  });

  it('fails CLOSED on unparsable/IPv6 peers and ignores bogus entries', () => {
    expect(ipv4InAllowlist('2001:db8::1', '10.0.0.0/8')).toBe(false);
    expect(ipv4InAllowlist('', '10.0.0.0/8')).toBe(false);
    expect(ipv4InAllowlist('10.1.2.3', 'not-an-ip, 10.0.0.0/99, 10.0.0.0/8')).toBe(true);
    expect(ipv4InAllowlist('10.256.0.1', '10.0.0.0/8')).toBe(false);
  });

  it('/0 matches everything; /32 is exact', () => {
    expect(ipv4InAllowlist('8.8.8.8', '0.0.0.0/0')).toBe(true);
    expect(ipv4InAllowlist('10.1.2.4', '10.1.2.3/32')).toBe(false);
  });
});

describe('platformRequireMfa flag parse', () => {
  it('truthy forms enable; default off', () => {
    expect(platformRequireMfa({} as NodeJS.ProcessEnv)).toBe(false);
    expect(platformRequireMfa({ PLATFORM_REQUIRE_MFA: 'true' } as unknown as NodeJS.ProcessEnv)).toBe(true);
    expect(platformRequireMfa({ PLATFORM_REQUIRE_MFA: '1' } as unknown as NodeJS.ProcessEnv)).toBe(true);
    expect(platformRequireMfa({ PLATFORM_REQUIRE_MFA: 'off' } as unknown as NodeJS.ProcessEnv)).toBe(false);
  });
});

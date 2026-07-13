// Depth follow-up (docs/45 residual — weather overlay): OPT-IN external weather signal for the demand-ml
// `weather` forecaster (forecast-algorithms.ts), mirroring th_holiday's shape but with a REAL rain signal
// instead of a fixed calendar. Vendor: Open-Meteo (https://open-meteo.com) — free, keyless, no signup;
// geocoding + historical archive + forecast are three separate public endpoints.
//
// OFF BY DEFAULT: DEMAND_WEATHER_ENABLED unset/false ⇒ resolveRainDates() never makes an outbound call and
// the `weather` forecaster always degrades to dow_seasonal — same opt-in posture as every other optional
// external integration in this codebase (audience-providers.ts, wallet-pass, etc.). Never throws: any
// failure (geocode miss, HTTP error, malformed body) yields an empty rain-date set, which is the SAME
// degrade path as "not configured" — no fabricated signal ever reaches the forecaster.
import { assertPublicUrl } from '../../common/net-guard';

const GEOCODE_URL = 'https://geocoding-api.open-meteo.com/v1/search';
const ARCHIVE_URL = 'https://archive-api.open-meteo.com/v1/archive';
const FORECAST_URL = 'https://api.open-meteo.com/v1/forecast';
const RAIN_MM_THRESHOLD = 1;        // ≥1mm/day counted as a rain day (WMO light-rain threshold)
const RAIN_PROB_PCT_THRESHOLD = 60; // ≥60% forecast precipitation probability counted as a rain day
const FORECAST_DAYS_MAX = 16;       // Open-Meteo's free-tier forecast horizon

// The three hosts above are compile-time constants — the SSRF gate is belt-and-suspenders here and skipped
// only under NODE_ENV=test so the fetch-stubbed harness stays hermetic (no live DNS in CI), same pattern
// as common/audience-providers.ts.
async function gate(url: string): Promise<void> {
  if (process.env.NODE_ENV === 'test') return;
  await assertPublicUrl(url, { allowHttp: false });
}

export function weatherOverlayEnabled(): boolean {
  return process.env.DEMAND_WEATHER_ENABLED === 'true' || process.env.DEMAND_WEATHER_ENABLED === '1';
}

interface GeoPoint { lat: number; lon: number }
const geoCache = new Map<string, { point: GeoPoint | null; expires: number }>();
const GEO_TTL_MS = 30 * 24 * 60 * 60_000; // 30 days — provinces don't move

// Resolve a Thai province name to coordinates via Open-Meteo's free geocoder. Cached per province string;
// never throws (an unknown/misspelled province just yields no weather signal, not an error).
export async function geocodeProvince(province: string): Promise<GeoPoint | null> {
  const key = province.trim().toLowerCase();
  if (!key) return null;
  const cached = geoCache.get(key);
  if (cached && cached.expires > Date.now()) return cached.point;
  let point: GeoPoint | null = null;
  try {
    const url = `${GEOCODE_URL}?name=${encodeURIComponent(province)}&count=1&language=en&format=json&country=TH`;
    await gate(url);
    const res = await fetch(url);
    const json: any = await res.json().catch(() => null);
    const hit = json?.results?.[0];
    if (hit) point = { lat: Number(hit.latitude), lon: Number(hit.longitude) };
  } catch { /* geocode failure — no weather signal for this province */ }
  geoCache.set(key, { point, expires: Date.now() + GEO_TTL_MS });
  return point;
}

const rainCache = new Map<string, { dates: Set<string>; expires: number }>();
const RAIN_TTL_MS = 6 * 60 * 60_000; // 6h — matches typical forecast-model refresh cadence

// Fetch the ISO dates flagged "rainy" across [startDate..lastDate] (historical archive) PLUS up to
// FORECAST_DAYS_MAX days beyond lastDate (forecast) — the union the `weather` forecaster needs to classify
// both history and the forecast horizon. Cached per (point, startDate, lastDate). Never throws: a failed
// leg just contributes no dates from that leg (history-only or forecast-only signal still helps).
export async function fetchRainDates(point: GeoPoint, startDate: string, lastDate: string): Promise<Set<string>> {
  const cacheKey = `${point.lat.toFixed(2)},${point.lon.toFixed(2)}|${startDate}|${lastDate}`;
  const cached = rainCache.get(cacheKey);
  if (cached && cached.expires > Date.now()) return cached.dates;
  const dates = new Set<string>();
  try {
    const archiveUrl = `${ARCHIVE_URL}?latitude=${point.lat}&longitude=${point.lon}&start_date=${startDate}&end_date=${lastDate}&daily=precipitation_sum&timezone=Asia%2FBangkok`;
    await gate(archiveUrl);
    const res = await fetch(archiveUrl);
    const json: any = await res.json().catch(() => null);
    const days: string[] = json?.daily?.time ?? [];
    const precip: number[] = json?.daily?.precipitation_sum ?? [];
    days.forEach((d, i) => { if ((precip[i] ?? 0) >= RAIN_MM_THRESHOLD) dates.add(d); });
  } catch { /* archive miss — history just carries no rain signal */ }
  try {
    const forecastUrl = `${FORECAST_URL}?latitude=${point.lat}&longitude=${point.lon}&daily=precipitation_probability_max&forecast_days=${FORECAST_DAYS_MAX}&timezone=Asia%2FBangkok`;
    await gate(forecastUrl);
    const res = await fetch(forecastUrl);
    const json: any = await res.json().catch(() => null);
    const days: string[] = json?.daily?.time ?? [];
    const prob: number[] = json?.daily?.precipitation_probability_max ?? [];
    days.forEach((d, i) => { if ((prob[i] ?? 0) >= RAIN_PROB_PCT_THRESHOLD) dates.add(d); });
  } catch { /* forecast miss — horizon just carries no rain signal */ }
  rainCache.set(cacheKey, { dates, expires: Date.now() + RAIN_TTL_MS });
  return dates;
}

// End-to-end: province → geocode → rain dates. Never throws; returns an empty Set when disabled,
// unconfigured, or on any failure — the forecaster's natural degrade-to-dow_seasonal path.
export async function resolveRainDates(province: string | null | undefined, startDate: string, lastDate: string): Promise<Set<string>> {
  if (!weatherOverlayEnabled() || !province) return new Set();
  try {
    const point = await geocodeProvince(province);
    if (!point) return new Set();
    return await fetchRainDates(point, startDate, lastDate);
  } catch {
    return new Set();
  }
}

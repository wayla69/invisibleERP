// Server shell (docs/28 §4 RSC pattern): the route is a server component; the master/detail interactivity
// (select a vendor, date range, CSV export) lives in the client island, which owns the fetching.
import { VendorCardsClient } from './vendors-client';

export const dynamic = 'force-dynamic';

export default function VendorCardsPage() {
  return <VendorCardsClient />;
}

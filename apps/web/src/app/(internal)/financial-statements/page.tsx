// Server shell (docs/28 §4 RSC pattern): the route is a server component; all interactivity — tab switch,
// date ranges, ledger selector, cash-flow method, CSV export — lives in the client island. The statements
// depend on client-selected filters (dates/tab/ledger), so the island owns the fetching (no server prefetch).
import { FinancialStatementsClient } from './financial-statements-client';

export const dynamic = 'force-dynamic';

export default function FinancialStatementsPage() {
  return <FinancialStatementsClient />;
}

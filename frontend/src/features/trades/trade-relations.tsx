import { useCallback, useState } from 'react';
import { jsonRequest } from '@/lib/api';
import { useSearchParams } from '@/lib/navigation';
import { usePoll } from '@/shared/api/use-poll';
import { EvidenceTable } from '@/shared/components/evidence';
import { ChangeReview } from '@/shared/components/change-review';
import { MoneyAmount } from '@/app/workflow/money-amount';
import { time } from '@/shared/components/operator-primitives';

type Kind = 'orders' | 'fills' | 'money' | 'events';
const LABELS = { orders: 'Alle Ordergenerationen', fills: 'Einzelne Fillbelege', money: 'Originale Geldereignisse und FX', events: 'Gespeicherte Ausführungsereignisse' };
const COLUMNS: Record<Kind, Array<[string, string]>> = {
  orders: [['id', 'Order-ID'], ['role', 'Rolle'], ['status', 'Orderstatus'], ['quantity', 'Menge'], ['filledQuantity', 'Kumulativ gefüllt'], ['price', 'Preis'], ['triggerPrice', 'Trigger'], ['reduceOnly', 'Reduce-only'], ['clientOrderId', 'Client-ID'], ['exchangeOrderId', 'Börsen-ID'], ['reason', 'Grund']],
  fills: [['id', 'Fill-ID'], ['orderId', 'Order-ID'], ['exchangeFillId', 'Börsen-Fill-ID'], ['identityStatus', 'Identität'], ['quantity', 'Menge'], ['price', 'Preis'], ['fee', 'Originalgebühr'], ['feeAsset', 'Gebührenwährung'], ['filledAt', 'Fillzeit']],
  money: [['id', 'Ereignis-ID'], ['kind', 'Art'], ['amount', 'Originalbetrag'], ['asset', 'Originalwährung'], ['valuationStatus', 'Bewertung'], ['reporting', 'Reportingwert'], ['occurredAt', 'Ereigniszeit'], ['valuationEvidenceId', 'Bewertungsbeleg']],
  events: [['id', 'Ereignis-ID'], ['eventType', 'Ereignis'], ['occurredAt', 'Zeitpunkt'], ['correlationId', 'Korrelation'], ['detailsOmitted', 'Technische Details überschreiten Anzeigegrenze']],
};
export function TradeRelations({ intentId, kind }: { intentId: string; kind: Kind }) {
  const [params, setParams] = useSearchParams(); const cursorKey = `${kind}Cursor`; const cursor = params.get(cursorKey) ?? '';
  const query = new URLSearchParams({ intentId, kind, limit: '40', ...(cursor ? { cursor } : {}) }).toString();
  const [state, setState] = useState<any>(null); const [error, setError] = useState('');
  const read = useCallback(async (signal: AbortSignal) => ({ query, page: await jsonRequest(`/api/trading/intents/relations?${query}`, { signal }) }), [query]);
  usePoll(read, result => { setState(result); setError(''); }, reason => setError(reason.message), 10000);
  const page = state?.query === query ? state.page : null;
  const changePage = (next: string | null) => setParams(previous => { if (next) previous.set(cursorKey, next); else previous.delete(cursorKey); return previous; });
  const rows = (page?.entries ?? []).map((row: any) => ({ ...row, ...(row.filledAt !== undefined ? { filledAt: time(row.filledAt) } : {}), ...(row.occurredAt !== undefined ? { occurredAt: time(row.occurredAt) } : {}),
    reporting: <MoneyAmount value={row.reportingValue} amount={row.reportingAmount} currency={row.reportingCurrency} status={row.valuationStatus === 'valued' ? 'complete' : 'unresolved'} /> }));
  return <section aria-label={LABELS[kind]} className="space-y-3"><h3>{LABELS[kind]}</h3>
    {error && <p role="alert">{error} · Vorhandene Belege können veraltet sein.</p>}
    {page ? <><p>Beobachtet {time(page.observedAt)} · {page.hasMore ? 'Weitere Serverseiten vorhanden' : 'Ende der Auswahl'}. Zustände und Bewertung werden pro Seite erneut gelesen.</p>
      <EvidenceTable caption={LABELS[kind]} rows={rows} columns={COLUMNS[kind]} />
      {kind === 'money' && page.entries.map((row: any) => <details key={row.id}><summary>Geldherkunft und Bewertung · {row.id}</summary><p>{row.explanation}</p>{row.originalUnverified && <p role="alert">Originalintegrität ungeklärt. Die gespeicherten Skalare sind kein bestätigtes Rechnungsergebnis.</p>}{row.valuationReason && <p>{row.valuationReason}</p>}<ChangeReview after={{ source: row.source, basis: row.basis, fillId: row.fillId, providerEventId: row.providerEventId, amount: row.amount, asset: row.asset, reportingValue: row.reportingValue, conversion: row.conversion }} showAll label={`Bewertungsquelle ${row.id}`} /></details>)}
      {kind === 'events' && page.entries.filter((row: any) => row.details).map((row: any) => <details key={row.id}><summary>Ereignisbeleg · {row.eventType} · {row.id}</summary><ChangeReview after={row.details} showAll label={`Ereignisdetails ${row.id}`} /></details>)}
      <div className="flex gap-3"><button className="secondary-button" disabled={!cursor} onClick={() => changePage(null)}>Erste {kind === 'orders' ? 'Orderseite' : kind === 'fills' ? 'Fillseite' : kind === 'money' ? 'Geldseite' : 'Ereignisseite'}</button><button className="secondary-button" disabled={!page.hasMore} onClick={() => changePage(page.nextCursor)}>Weitere {kind === 'orders' ? 'Orders' : kind === 'fills' ? 'Fills' : kind === 'money' ? 'Geldbelege' : 'Ereignisse'}</button></div>
    </> : !error && <p role="status">Belege werden geladen …</p>}
  </section>;
}

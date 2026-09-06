import { useCallback, useState } from 'react';
import { jsonRequest } from '@/lib/api';
import { Link, useSearchParams } from '@/lib/navigation';
import { usePoll } from '@/shared/api/use-poll';
import { EvidenceFields, EvidenceTable } from '@/shared/components/evidence';
import { ChangeReview } from '@/shared/components/change-review';
import { MoneyAmount } from '@/app/workflow/money-amount';
import { time } from '@/shared/components/operator-primitives';

function useEvidence(url: string) {
  const [state, setState] = useState<any>(null); const [error, setError] = useState('');
  const read = useCallback((signal: AbortSignal) => jsonRequest(url, { signal }), [url]);
  usePoll(read, value => { setState({ url, value }); setError(''); }, failure => setError(failure.message), 10000);
  return { data: state?.url === url ? state.value : null, error };
}

export function RiskAccounts() {
  const [params, setParams] = useSearchParams();
  const query = new URLSearchParams({ kind: 'accounts' }); if (params.has('cursor')) query.set('cursor', params.get('cursor')!);
  const { data, error } = useEvidence(`/api/trading/objects?${query}`);
  return <section className="space-y-4"><h1>Risiko- und Historienbelege je Konto</h1><p>Kontomodell und Währung bleiben getrennt. Ein lesbarer oder frischer Beleg ist keine neue Entry-Freigabe.</p>
    {error && <p role="alert">{error}</p>}{data ? <><EvidenceTable caption="Konten" columns={[["name", "Kontobelege öffnen"], ["exchange", "Börse"], ["mode", "Modus"], ["status", "Status"], ["retiredAt", "Entfernt"]]} rows={data.entries.map((row: any) => ({ ...row, name: <Link to={`/risk/accounts/${encodeURIComponent(row.id)}`}>{row.name}</Link>, retiredAt: time(row.retiredAt) }))} />
      <div className="flex gap-3"><button className="secondary-button" disabled={!params.has('cursor')} onClick={() => setParams(new URLSearchParams())}>Erste Seite</button><button className="secondary-button" disabled={!data.hasMore} onClick={() => setParams(new URLSearchParams({ cursor: data.nextCursor }))}>Nächste Seite</button></div></> : !error && <p role="status">Konten werden geladen …</p>}</section>;
}

function AccountEvidenceRows({ accountId, kind, observationId }: { accountId: string; kind: 'reservations' | 'history'; observationId?: string }) {
  const [params, setParams] = useSearchParams(); const cursorKey = `${kind}Cursor`;
  const query = new URLSearchParams({ accountId, kind }); if (params.has(cursorKey)) query.set('cursor', params.get(cursorKey)!);
  if (kind === 'reservations' && observationId) query.set('observationId', params.get('observationId') || observationId);
  const { data, error } = useEvidence(`/api/trading/accounts/evidence?${query}`);
  const go = (nextPage: boolean) => {
    const next = new URLSearchParams(params);
    if (nextPage) { next.set(cursorKey, data.nextCursor); if (kind === 'reservations') next.set('observationId', data.observation.id); }
    else { next.delete(cursorKey); if (kind === 'reservations') next.delete('observationId'); }
    setParams(next);
  };
  const title = kind === 'reservations' ? 'Gespeicherte Risikoreservierungen' : 'Provider-Historienfortschritt';
  const rows = data?.entries.map((row: any) => kind === 'history' ? { ...row, source: <span>{row.source} · {row.providerSymbol || 'Kontoscope'}</span>, updatedAt: time(row.updatedAt), scannedThrough: time(row.scannedThrough),
    details: <details><summary>Abdeckung und Grenzen</summary><ChangeReview label="Historienabdeckung" after={{ baselineSince: row.baselineSince, windowSince: row.windowSince, windowUntil: row.windowUntil, nextReadAt: row.nextReadAt, cursorPresent: row.cursorPresent, coverage: row.coverage, retention: row.retention }} /></details> }
    : { ...row, intentId: <Link to={`/trading/trades/${encodeURIComponent(row.intentId)}`}>{row.intentId}</Link>, status: row.amounts?.status ?? 'unbekannt',
      additional: <MoneyAmount value={row.amounts?.additionalRiskValue} amount={row.amounts?.additionalRisk} currency={row.amounts?.reportingCurrency} status={row.amounts?.status === 'complete' ? 'complete' : 'unresolved'} />,
      details: <details><summary>Stoprisiko, Quelle und FX</summary><EvidenceFields fields={[["Quelle", row.sourceHash], ["Mark zum Beobachtungszeitpunkt", row.markPrice], ["Fill-Durchschnitt", row.averageEntryPrice], ["Stop", row.stopPrice], ["Schutz zum Beobachtungszeitpunkt", row.protectionProven == null ? null : row.protectionProven === 1], ["FX-ID", row.fxId], ["FX-Verfall", time(row.fxExpiresAt)], ["Über Budget ausgelassene Betragsdetails", row.amountsOmitted === 1]]} />
        <ChangeReview label="Risikobeträge aus der Originalbeobachtung" after={row.amounts} /></details> });
  const columns: Array<[string, string]> = kind === 'history' ? [['source', 'Quelle / Scope'], ['completeness', 'Vollständigkeit'], ['scannedThrough', 'Durchsucht bis'], ['updatedAt', 'Aktualisiert'], ['reason', 'Grund']] : [['intentId', 'Trade'], ['status', 'Bewertung'], ['additional', 'Zusätzlich reserviertes Risiko']];
  return <section className="operations-card space-y-3"><h2>{title}</h2>{error && <p role="alert">{error} Angezeigte Werte können veraltet sein.</p>}
    {data ? <><p>{data.interpretation}</p>{data.observation && <p>Beobachtung {data.observation.id} · {time(data.observation.observedAt)} · {data.observation.timestampFresh ? 'Zeitgrenze noch gültig' : 'Zeitgrenze abgelaufen oder ungültig'} · {data.observation.isCurrentObservation ? 'aktuelle gespeicherte Projektion' : 'historische Projektion'}.</p>}
      <EvidenceTable caption={title} rows={rows} columns={columns} /><div className="space-y-4">{rows.map((row: any, index: number) => <div key={row.id ?? index} className="border-t pt-3"><p>{kind === "history" ? row.source : row.intentId}</p>{row.details}</div>)}</div><div className="flex gap-3"><button className="secondary-button" disabled={!params.has(cursorKey) && !(kind === 'reservations' && params.has('observationId'))} onClick={() => go(false)}>Aktuelle erste Seite</button><button className="secondary-button" disabled={!data.hasMore} onClick={() => go(true)}>Weitere {kind === 'history' ? 'Historienbelege' : 'Reservierungen'}</button></div></> : !error && <p role="status">Belege werden geladen …</p>}
  </section>;
}

export function RiskAccountEvidence({ accountId }: { accountId: string }) {
  const { data, error } = useEvidence(`/api/trading/accounts/evidence?accountId=${encodeURIComponent(accountId)}`);
  if (!data) return <section><h1>Kontorisiko</h1><p role={error ? 'alert' : 'status'}>{error || 'Kontobelege werden geladen …'}</p></section>;
  const { account, daily, risk } = data;
  const money = (value: any, amount: string | null) => <MoneyAmount value={value} amount={amount} currency={daily.reportingCurrency} status={daily.valuationStatus === 'valued' ? 'complete' : 'unresolved'} />;
  return <section className="space-y-5"><h1>{account.name} · Risiko & Historie</h1><p>{account.exchange}/{account.mode} · gelesen {time(data.observedAt)}.</p>
    <nav className="flex flex-wrap gap-4"><Link to={`/trading/accounts/${encodeURIComponent(accountId)}`}>Konto, Schutz und zulässige Commands</Link><Link to={`/trading/operations?accountId=${encodeURIComponent(accountId)}`}>Ungeklärte Börsenoperationen prüfen</Link><Link to={`/trading/journal?accountId=${encodeURIComponent(accountId)}`}>Journal, Gebühren und FX je Trade</Link><Link to={`/workflows/paths?accountId=${encodeURIComponent(accountId)}`}>Aktive Pfade und Policen</Link></nav>
    {error && <p role="alert">{error} Daten können veraltet sein.</p>}<p>{data.interpretation}</p>
    {data.errors?.map((failure: any) => <p key={failure.source} role="alert">{failure.source}: {failure.reason}</p>)}<section className="operations-card space-y-3"><h2>Abrechnung im UTC-Risikotag</h2>{daily ? <><p>{new Date(daily.since).toISOString()} bis {new Date(daily.until).toISOString()} · Anzeigezeit lokal: {time(daily.until)}.</p>
      <dl className="grid gap-4 sm:grid-cols-2"><div><dt>Realisierter Preis-PnL</dt><dd>{money(daily.pricePnlValue, daily.pricePnl)}</dd></div><div><dt>Gebühren (vorzeichenbehaftet)</dt><dd>{money(daily.feesValue, daily.fees)}</dd></div><div><dt>Funding</dt><dd>{money(daily.fundingValue, daily.funding)}</dd></div><div><dt>Bewerteter Tagesbetrag</dt><dd>{money(daily.value, daily.amount)}</dd></div></dl>
      <EvidenceFields fields={[["Bewertungsstatus", daily.valuationStatus], ["Historienvollständigkeit dieses Geld-Ledgers", daily.historyCompleteness], ["Ungeklärte Ereignisse", daily.unresolvedEventCount], ["Konflikte", daily.conflictCount], ["Offene Projektionen", daily.pendingProjections], ["Ungeklärte Projektionen", daily.unresolvedProjections], ["Bewertungshash", daily.valuationHash]]} />
      <p>Eine vollständige Bewertung vorhandener Ereignisse beweist keine vollständige Börsenhistorie. Tageslimits werden im aktiven Pfad und beim Entry geprüft.</p></> : <p>Die Tagesabrechnung ist nicht verfügbar. Andere Kontobelege bleiben unabhängig lesbar.</p>}</section>
    <section className="operations-card"><h2>Gespeicherte Risiko- und Bestandsbeobachtung</h2>{risk ? <><EvidenceFields fields={[["Beobachtung", risk.id], ["Zeitpunkt", time(risk.observedAt)], ["Gültig bis", time(risk.expiresAt)], ["Zeitgrenze gültig", risk.timestampFresh], ["Aktuelle Kontoidentität passend", risk.identityMatches], ["Credentialgeneration passend", risk.credentialGenerationMatches], ["Reservierungen", risk.reservationCount], ["Bestandsquelle", risk.balanceSourceObservationId], ["Bestandsbeobachtung", time(risk.balanceObservedAt)], ["Bestandswährung", risk.balanceCurrency], ["Eigenkapital", risk.equity], ["Verfügbar", risk.availableBalance], ["Unrealized PnL", risk.unrealizedPnl], ["Bestandsfehler", risk.balanceReason]]} />
      <p>Die Engine prüft zusätzlich ihre aktuelle Entry-Epoche, zwischenzeitliche Order-/Fill-/Stopänderungen und FX-Originale. Diese Anzeige erteilt keine Freigabe.</p></> : <p>Keine gespeicherte Risikobeobachtung vorhanden. Das bedeutet weder Nullrisiko noch bestätigten Schutz.</p>}</section>
    {risk && <AccountEvidenceRows accountId={accountId} kind="reservations" observationId={risk.id} />}
    <section className="operations-card"><h2>Beginn der erforderlichen Vergangenheit</h2><EvidenceFields fields={[["Etablierte Ausgangsgrenze", data.baseline?.id], ["Grenzzeit", time(data.baseline?.boundary)], ["Erforderlich ab einschließlich älterer lokaler Orders", time(data.requiredHistorySince)]]} /><p>Fehlende oder ältere lokale Verpflichtungen können eine längere Providerhistorie erfordern. Ein unbekannter Fremdauftrag bleibt davon getrennt.</p></section>
    <AccountEvidenceRows accountId={accountId} kind="history" />
  </section>;
}

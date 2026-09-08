import { listEntries } from "@/shared/list-entries";
import { useCallback, useState } from 'react';
import { jsonRequest, mutateAndObserve } from '@/lib/api';
import { Link } from '@/lib/navigation';
import { usePoll } from '@/shared/api/use-poll';
import { useOperatorReadOnly } from '@/shared/api/operator-session';
import { ChangeReview } from '@/shared/components/change-review';
import { EvidenceFields } from '@/shared/components/evidence';
import { time } from '@/shared/components/operator-primitives';

export function ProposalDetail({ id }: Readonly<{ id: string }>) {
  const readOnly = useOperatorReadOnly(); const [review, setReview] = useState<any>(null); const [error, setError] = useState('');
  const [acceptedHash, setAcceptedHash] = useState(''); const [reason, setReason] = useState(''); const [busy, setBusy] = useState(false); const [message, setMessage] = useState('');
  const load = useCallback((signal?: AbortSignal) => jsonRequest(`/api/mcp/proposals/detail?id=${encodeURIComponent(id)}`, { signal }), [id]);
  usePoll(load, value => { setReview(value); setError(''); }, failure => setError(failure.message), 5000);
  const decide = async (approve: boolean) => {
    if (readOnly || busy || !review || (approve && acceptedHash !== review.reviewHash)) return;
    setBusy(true); setMessage('');
    try {
      const result = await mutateAndObserve(() => jsonRequest(`/api/mcp/proposals/${approve ? 'approve' : 'reject'}`, { method: 'POST',
        headers: approve ? { 'X-Destructive-Confirmation': 'approve-mcp-proposal' } : undefined,
        body: JSON.stringify(approve ? { id, reviewHash: acceptedHash } : { id, reason }) }),
      value => { setReview((current: any) => ({ ...current, proposal: value.proposal })); setMessage(approve ? 'Freigabe bestätigt. Die Ausführung erfolgt separat; Ergebnis hier weiter prüfen.' : 'Ablehnung bestätigt.'); setAcceptedHash(''); },
      async () => setReview(await load()));
      if (result.refreshError) setError(`Entscheidung bestätigt, Nachladen fehlgeschlagen: ${result.refreshError}`);
    } catch (error_) { setMessage(`Entscheidung nicht bestätigt: ${error_ instanceof Error ? error_.message : String(error_)}. Status prüfen; keine automatische Wiederholung.`); }
    finally { setBusy(false); }
  };
  if (!review) return <section><h1>MCP-Vorschlag</h1><p>{error ? <span role="alert">{error}</span> : <output>Prüfinhalt wird geladen …</output>}</p></section>;
  const proposal = review.proposal; const pending = proposal.status === 'pending' && proposal.expiresAt > Date.now();
  return <section className="space-y-5"><Link to="/integrations/mcp">MCP & Agenten</Link><h1>Vorschlag prüfen · {proposal.action}</h1>
    {error && <p role="alert">{error} · Angezeigte Vorschau kann veraltet sein.</p>}{message && <p><output>{message}</output></p>}
    <EvidenceFields fields={[["Vorschlag", id], ["Agent", proposal.agentName], ["Zustand", proposal.status], ["Beantragt", time(proposal.requestedAt)], ["Läuft ab", time(proposal.expiresAt)], ["Entschieden von", proposal.decidedBy], ["Ausführung beendet", time(proposal.executedAt)], ["Beobachtet", time(review.observedAt)]]} />
    <p>{review.interpretation}</p><h2>Geltungsbereich und Wirkung</h2>
    <p>{review.scope.globalEntryEffects ? 'Globale Änderung der Entry-Sperre. Konten benötigen weiterhin ihre eigenen Freigaben und Schutzbelege.' : 'Zukünftige Konfiguration des ausgewählten Objekts; bestehende Trades behalten ihre ursprünglichen Pläne.'}</p>
    <ul>{review.scope.accountIds.map((account: string) => <li key={account}><Link to={`/trading/accounts/${encodeURIComponent(account)}`}>Konto {account}</Link></li>)}</ul>
    <p>{review.scope.paths.length} betroffene aktive Pfade · Revision {review.scope.activeRevisionId ?? 'nicht vorhanden'}</p>
    <ul>{review.scope.paths.map((path: any) => <li key={path.id}><Link to={`/workflows/paths/${encodeURIComponent(path.id)}`}>{path.id}</Link> · Kanal {path.channelId}</li>)}</ul>
    <section><h2>Voraussetzungen</h2><p>Ursprünglicher Preflight: {time(proposal.preflight?.checkedAt)} · Alter {Math.max(0, Math.floor((review.observedAt - proposal.preflight?.checkedAt) / 1000))} s</p>
      <p>Neu geprüft: {time(review.freshPreflight.checkedAt)} · {review.freshPreflight.allowed ? 'Vorschau ohne Blocker' : 'gesperrt'}. Auch eine Freigabe ersetzt die Prüfung bei Ausführung nicht.</p>
      <ul>{listEntries<string>([...(review.freshPreflight.blockers ?? []), ...(review.freshPreflight.impact ?? [])], item => item).map(({ item, key }) => <li key={key}>{item}</li>)}</ul></section>
    <ChangeReview before={review.before} after={review.requested} />
    <details><summary>Vollständiger redigierter Antragsinhalt</summary><ChangeReview after={proposal.payload} showAll label="Antragsinhalt" /></details>
    {proposal.result != null && <ChangeReview after={proposal.result} showAll label="Bestätigtes Ausführungsergebnis" />}{proposal.error && <p role="alert">{proposal.error}</p>}
    {readOnly ? <p>Für Vorschlagsentscheidungen ist eine Administratorrolle erforderlich.</p> : pending && <div className="space-y-3">
      <label className="flex gap-2"><input type="checkbox" checked={acceptedHash === review.reviewHash} onChange={event => setAcceptedHash(event.target.checked ? review.reviewHash : '')} />Inhalt, Scope und beantragte Risikoänderungen geprüft</label>
      <button type="button" className="primary-button" disabled={busy || Boolean(error) || !review.freshPreflight.allowed || acceptedHash !== review.reviewHash} onClick={() => { decide(true); }}>Geprüften Vorschlag freigeben</button>
      <label>Ablehnungsgrund<input className="block border bg-background p-2" maxLength={500} value={reason} onChange={event => setReason(event.target.value)} /></label>
      <button type="button" className="secondary-button" disabled={busy || !reason.trim()} onClick={() => { decide(false); }}>Mit Begründung ablehnen</button>
    </div>}
  </section>;
}

import { useCallback, useState } from 'react';
import { jsonRequest, mutateAndObserve } from '@/lib/api';
import { Link } from '@/lib/navigation';
import { usePoll } from '@/shared/api/use-poll';
import { EvidenceFields, EvidenceTable } from '@/shared/components/evidence';
import { useConfirmationDialog } from '@/components/confirmation-dialog';

export function AccountDetail({ id, readOnly }: { id: string; readOnly: boolean }) {
  const [value, setValue] = useState<any>(null); const [error, setError] = useState(''); const [message, setMessage] = useState(''); const [busy, setBusy] = useState(false);
  const { confirm, confirmationDialog } = useConfirmationDialog();
  const read = useCallback((signal: AbortSignal) => jsonRequest(`/api/trading/accounts/detail?id=${encodeURIComponent(id)}`, { signal }), [id]);
  usePoll(read, (data) => { setValue(data); setError(''); }, (reason) => setError(reason.message));
  const command = async (action: 'cancel-entries' | 'emergency-flatten') => {
    if (readOnly || busy) return;
    const emergency = action === 'emergency-flatten';
    if (!await confirm({ title: emergency ? 'Verwaltete Positionen dieses Kontos schließen' : 'Offene Entries dieses Kontos stornieren',
      description: emergency ? `Konto ${value.account.name}: verwaltete Positionen werden geschlossen. Neue Entries werden GLOBAL deaktiviert und der globale Kill-Switch wird gesetzt. Unbewiesenes Eigentum blockiert die Ausführung. Abschluss und Restposition müssen anschließend geprüft werden.` : `Konto ${value.account.name}: nur offene Entry-Orders werden storniert. Bestehende Positionen und Schutzorders sind eigene Aufgaben. Ein unbekanntes Cancel-Ergebnis wird nicht als Abschluss angezeigt.`,
      confirmationText: emergency ? 'FLATTEN MANAGED POSITIONS' : undefined, confirmLabel: emergency ? 'Notausstieg anfordern' : 'Entry-Storno anfordern', destructive: true })) return;
    setBusy(true); setError('');
    try {
      const { refreshError } = await mutateAndObserve(() => jsonRequest(`/api/trading/${action}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ accountId: id, ...(emergency ? { confirmation: 'FLATTEN MANAGED POSITIONS' } : {}) }) }),
        () => setMessage('Command beantwortet. Operationszustände und Restpositionen bestätigen den tatsächlichen Abschluss.'), async () => setValue(await read(new AbortController().signal)));
      if (refreshError) setMessage(`Command beantwortet; Nachladen fehlgeschlagen: ${refreshError}`);
    } catch (reason) { setError(`${reason instanceof Error ? reason.message : String(reason)} Kein automatischer Wiederholungsversuch.`); }
    finally { setBusy(false); }
  };
  if (!value) return <section><h1>Konto {id}</h1><p role={error ? 'alert' : 'status'}>{error || 'Kontobelege werden geladen …'}</p></section>;
  const account = value.account;
  return <div className="operations-stack">{confirmationDialog}<h1>{account.name} · {account.exchange}/{account.mode}</h1>
    {error && <p role="alert">{error} Daten können veraltet sein.</p>}{message && <p role="status">{message}</p>}
    <section className="operations-card"><h2>Identität, Kapazität und Beobachtungen</h2><EvidenceFields fields={[
      ['Konto-ID', id], ['Kontomodus', account.mode], ['Aktiv', account.enabled], ['Status', account.status], ['Konto-Kill-Switch', account.killSwitchActive], ['Sperrgrund', account.killSwitchReason],
      ['Identitätsfingerprint (redigiert)', account.identityFingerprint], ['Credentialgeneration', account.credentialGeneration], ['Kontoversion', account.stateVersion],
      ['Positionsgrenze über alle Pfade', account.maxConcurrentPositions], ['Offene Positionen (Repository)', value.capacity?.openPositions],
      ['Letzte Verifizierung (UTC ms)', account.lastVerifiedAt], ['Letzter REST-Abgleich', value.reconciliation?.status], ['REST-Abschluss (UTC ms)', value.reconciliation?.completedAt],
      ['Streamzustand', value.stream?.status], ['Streamlücken', value.stream?.gapCount], ['Letztes Streamereignis (UTC ms)', value.stream?.lastEventAt], ['Fehler', account.reason],
    ]} /><p>Beobachtet {new Date(value.observedAt).toLocaleString('de-DE')}. Verifizierung, Streamgesundheit und Handelsschutz sind unterschiedliche Nachweise.</p></section>
    <section className="operations-card"><h2>Aktueller Schutz</h2>{value.protection.length ? value.protection.map((item: any) => <div key={item.intentId}><Link to={`/trading/trades/${encodeURIComponent(item.intentId)}`}>{item.intentId}</Link><p>{item.protected ? 'Aktueller Serverbeleg vorhanden' : 'Schutz nicht aktuell bewiesen'} · {item.reason ?? item.proof?.purpose ?? item.noDuty?.noSendBasis}</p><p>Prüfzeit (UTC ms): {item.proof?.evaluatedAt ?? 'nicht verfügbar'} · Beleg: {item.proof?.evidenceHash ?? item.noDuty?.noSendEvidenceHash ?? 'nicht verfügbar'}</p></div>) : <p>Kein aktueller Schutzbeleg in dieser Projektion. Dies ist keine Freigabe.</p>}{value.hasMore.protection && <p>Weitere Schutzpflichten vorhanden. Über die paginierte Positions-/Intentliste zum einzelnen Beleg wechseln.</p>}</section>
    <section className="operations-card"><h2>Verbundene aktive Pfade</h2><EvidenceTable caption="Aktive Pfade (bis 100)" rows={value.paths} columns={[["id", "Pfad-ID"], ["channelId", "Kanal"], ["workflowRevisionId", "Originalrevision"], ["enabled", "Aktiv"]]} />{value.hasMore.paths && <p>Weitere Pfade vorhanden.</p>}</section>
    <nav aria-label="Kontoobjekte" className="flex flex-wrap gap-4"><Link to={`/risk/accounts/${encodeURIComponent(id)}`}>Risiko, Geld und Historienbelege</Link>{[['positions', 'Positionen'], ['orders', 'Orders'], ['operations', 'Börsenoperationen'], ['incidents', 'Vorfälle'], ['reconciliations', 'REST-Verlauf'], ['journal', 'Journal']].map(([path, label]) => <Link key={path} to={`/trading/${path}?accountId=${encodeURIComponent(id)}`}>{label}</Link>)}</nav>
    <section className="operations-card"><h2>Sichere Reduktion und Notausstieg</h2>{readOnly && <p>Viewer: Commands sind gesperrt.</p>}<button className="secondary-button" disabled={readOnly || busy} onClick={() => void command('cancel-entries')}>Entries dieses Kontos stornieren</button><button className="danger-button" disabled={readOnly || busy} onClick={() => void command('emergency-flatten')}>Konto-Notausstieg · globale Entry-Sperre</button></section>
  </div>;
}

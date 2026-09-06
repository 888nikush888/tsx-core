import { useCallback, useState } from 'react';
import { Link } from '@/lib/navigation';
import { jsonRequest } from '@/lib/api';
import { usePoll } from '@/shared/api/use-poll';
import { useOperatorReadOnly } from '@/shared/api/operator-session';
import { useConfirmationDialog } from '@/components/confirmation-dialog';
import { EvidenceFields, EvidenceTable } from '@/shared/components/evidence';
import { JobLink } from './jobs-page';

export function BackupsPage({ name }: { name?: string }) {
  const readOnly = useOperatorReadOnly();
  const [value, setValue] = useState<any>(null); const [error, setError] = useState('');
  const [message, setMessage] = useState(''); const [busy, setBusy] = useState(false);
  const [jobId, setJobId] = useState(''); const [objectName, setObjectName] = useState('');
  const { confirm, confirmationDialog } = useConfirmationDialog();
  const read = useCallback((signal: AbortSignal) => jsonRequest(name ? `/api/backups/verify?name=${encodeURIComponent(name)}` : '/api/backups', { signal }), [name]);
  usePoll(read, payload => { setValue(payload); setError(''); }, reason => setError(reason.message), name ? 30_000 : 10_000);
  const command = async (kind: 'create' | 'drill' | 'restore' | 'recover') => {
    if (readOnly || busy) return;
    if (kind !== 'create' && !await confirm({ title: kind === 'drill' ? 'Isolierter Restore-Probelauf' : kind === 'restore' ? 'Backup wiederherstellen' : 'Offsite-Backup zurückholen',
      description: kind === 'drill' ? `${name}: Prüft das Artefakt in einem isolierten Prozess ohne Handels- oder Telegram-Verbindung. Der laufende Core wird nicht ersetzt.`
        : kind === 'restore' ? `${name}: Stoppt Routing und Trading, prüft Wartung, Besitz und Wiederherstellbarkeit, ersetzt die gesicherten Daten und fordert einen Neustart an. Konten und Entry-Freigaben müssen danach erneut geprüft werden. Ein Fehler kann den Dienst im Wartungszustand belassen.`
          : `${objectName}: Lädt das benannte Backup herunter, entschlüsselt und prüft es. Dies stellt die laufende Installation noch nicht wieder her.`,
      confirmationText: kind === 'restore' ? 'RESTORE' : kind === 'recover' ? 'RECOVER' : undefined,
      confirmLabel: kind === 'drill' ? 'Probelauf starten' : kind === 'restore' ? 'Wiederherstellen' : 'Zurückholen', destructive: kind === 'restore',
    })) return;
    const id = crypto.randomUUID(); setJobId(id); setBusy(true); setError(''); setMessage('Auftrag wird gesendet. Bei Verbindungsabbruch ausschließlich den Auftragsstatus prüfen.');
    const endpoint = kind === 'create' ? '/api/operations/backup' : kind === 'drill' ? '/api/operations/backup-drill' : kind === 'restore' ? '/api/backups/restore' : '/api/backups/recover-offsite';
    try {
      const response = await jsonRequest(endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Operator-Job-ID': id,
        ...(kind === 'create' ? {} : { 'X-Destructive-Confirmation': kind === 'drill' ? 'run-backup-drill' : kind === 'restore' ? 'restore-backup' : 'recover-offsite-backup' }) },
        body: JSON.stringify({ jobId: id, ...(kind === 'recover' ? { objectName: objectName.trim() } : name ? { name } : {}) }),
      });
      setMessage(response.job ? 'Auftrag dauerhaft angenommen. Den Abschluss und bestätigte Teilwirkungen im Auftragsverlauf prüfen.' : 'Antwort empfangen; dieser Server liefert keinen dauerhaften Auftragsbeleg. Ergebnis und Dienstzustand separat prüfen.');
    } catch (reason) { setError(`Aktion nicht bestätigt: ${reason instanceof Error ? reason.message : String(reason)}. Nicht automatisch wiederholen; zuerst Auftrag und Betriebszustand prüfen.`); }
    finally { setBusy(false); }
  };
  const evidence = value?.evidence;
  return <div className="operations-stack">{confirmationDialog}<h1>{name ? 'Backup-Artefakt' : 'Verifizierte Backups'}</h1>
    <p>Integrität, gemeinsame Konfiguration, Wiederherstellbarkeit, Offsite-Beleg und Probelauf sind getrennte Nachweise. Ein bestandener Probelauf ist keine Handelsfreigabe.</p>
    {name ? <Link to="/operations/backups">Alle Backups</Link> : <button className="primary-button" disabled={readOnly || busy} onClick={() => void command('create')}>Jetzt sichern</button>}
    {error && <p role="alert">{error}</p>}{message && <p role="status">{message}</p>}{jobId && <JobLink id={jobId} />}
    {readOnly && <p>Viewer: Prüfbelege können gelesen werden. Änderungen erfordern Administratorrechte.</p>}
    {name && evidence && <section className="operations-card"><h2>{name}</h2><EvidenceFields fields={[
      ['Artefakthash', evidence.artifactSha256], ['Erstellt', evidence.artifactCreatedAt == null ? null : new Date(evidence.artifactCreatedAt).toLocaleString('de-DE')],
      ['Integrität', evidence.integrityVerified ? `belegt · ${new Date(evidence.integrityVerified.verifiedAt).toLocaleString('de-DE')}` : null],
      ['Konfigurationskohärenz', evidence.configurationCoherent ? 'belegt' : null], ['Restore-Zulässigkeit', evidence.restoreEligibility?.status],
      ['Blocker', evidence.restoreEligibility?.reasons?.join('; ')], ['Offsite-Prüfung', evidence.offsiteVerified ? 'belegt (siehe Artefaktbeleg)' : null], ['Restore-Probelauf', evidence.restoreDrill ? 'belegt (siehe Artefaktbeleg)' : null],
    ]} /><div className="system-actions"><button disabled={busy || readOnly} onClick={() => void command('drill')}>Isolierten Probelauf starten</button><button className="danger-button" disabled={busy || readOnly || evidence.restoreEligibility?.status !== 'eligible'} onClick={() => void command('restore')}>Wiederherstellen</button></div><details><summary>Vollständige Prüfbelege</summary><pre className="whitespace-pre-wrap break-all text-sm">{JSON.stringify(evidence, null, 2)}</pre></details></section>}
    {!name && value && <EvidenceTable caption="Lokaler Artefaktbestand" rows={(value.backups ?? []).map((artifact: string) => ({ id: artifact, artifact: <Link className="underline" to={`/operations/backups/${encodeURIComponent(artifact)}`}>{artifact}</Link> }))} columns={[["artifact", "Artefakt öffnen & prüfen"]]} />}
    {!value && <p role="status">Backup-Nachweise werden geladen …</p>}
    {!name && <section className="operations-card system-form"><h2>Offsite-Backup zurückholen</h2><label>Objektname<input value={objectName} onChange={event => setObjectName(event.target.value)} placeholder="backup-….tgfb" maxLength={180} /></label><button disabled={busy || readOnly || !objectName.trim()} onClick={() => void command('recover')}>Herunterladen & prüfen</button></section>}
    <Link to="/operations/jobs">Dauerhafte Wartungsaufträge</Link>
    <aside className="operations-card"><h2>Wartung bei gestopptem Core</h2><p>Imagewechsel und Offline-Rollback benötigen den dokumentierten Deployment-Weg mit geprüften Images und Backups. Ein vollständig gestoppter Core kann diese Oberfläche nicht bereitstellen. Ein unabhängiger Host-Wartungsdienst gehört zur optionalen Erweiterung.</p></aside>
  </div>;
}

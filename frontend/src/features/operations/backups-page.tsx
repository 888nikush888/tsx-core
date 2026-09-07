import { useCallback, useState } from 'react';
import { Link } from '@/lib/navigation';
import { jsonRequest } from '@/lib/api';
import { usePoll } from '@/shared/api/use-poll';
import { useOperatorReadOnly } from '@/shared/api/operator-session';
import { useConfirmationDialog, type ConfirmationDialogOptions } from '@/components/confirmation-dialog';
import { EvidenceFields, EvidenceTable } from '@/shared/components/evidence';
import { JobLink } from './jobs-page';

type BackupCommand = 'create' | 'drill' | 'restore' | 'recover';
const BACKUP_COMMANDS = {
  create: { endpoint: '/api/operations/backup', confirmation: null },
  drill: { endpoint: '/api/operations/backup-drill', confirmation: 'run-backup-drill' },
  restore: { endpoint: '/api/backups/restore', confirmation: 'restore-backup' },
  recover: { endpoint: '/api/backups/recover-offsite', confirmation: 'recover-offsite-backup' },
};
function backupConfirmation(kind: Exclude<BackupCommand, 'create'>, name: string | undefined, objectName: string): ConfirmationDialogOptions {
  if (kind === 'drill') return {
    title: 'Isolierter Restore-Probelauf',
    description: `${name}: Prüft das Artefakt in einem isolierten Prozess ohne Handels- oder Telegram-Verbindung. Der laufende Core wird nicht ersetzt.`,
    confirmLabel: 'Probelauf starten', destructive: false,
  };
  if (kind === 'restore') return {
    title: 'Backup wiederherstellen',
    description: `${name}: Stoppt Routing und Trading, prüft Wartung, Besitz und Wiederherstellbarkeit, ersetzt die gesicherten Daten und fordert einen Neustart an. Konten und Entry-Freigaben müssen danach erneut geprüft werden. Ein Fehler kann den Dienst im Wartungszustand belassen.`,
    confirmationText: 'RESTORE', confirmLabel: 'Wiederherstellen', destructive: true,
  };
  return {
    title: 'Offsite-Backup zurückholen',
    description: `${objectName}: Lädt das benannte Backup herunter, entschlüsselt und prüft es. Dies stellt die laufende Installation noch nicht wieder her.`,
    confirmationText: 'RECOVER', confirmLabel: 'Zurückholen', destructive: false,
  };
}
function backupRequest(kind: BackupCommand, id: string, name: string | undefined, objectName: string) {
  const { endpoint, confirmation } = BACKUP_COMMANDS[kind];
  const scope = kind === 'recover' ? { objectName: objectName.trim() } : name ? { name } : {};
  const headers: Record<string, string> = { 'Content-Type': 'application/json', 'X-Operator-Job-ID': id };
  if (confirmation) headers['X-Destructive-Confirmation'] = confirmation;
  return { endpoint, init: { method: 'POST', headers, body: JSON.stringify({ jobId: id, ...scope }) } };
}

export function BackupsPage({ name }: { name?: string }) {
  const readOnly = useOperatorReadOnly();
  const [value, setValue] = useState<any>(null); const [error, setError] = useState('');
  const [message, setMessage] = useState(''); const [busy, setBusy] = useState(false);
  const [jobId, setJobId] = useState(''); const [objectName, setObjectName] = useState('');
  const { confirm, confirmationDialog } = useConfirmationDialog();
  const read = useCallback((signal: AbortSignal) => jsonRequest(name ? `/api/backups/verify?name=${encodeURIComponent(name)}` : '/api/backups', { signal }), [name]);
  usePoll(read, payload => { setValue(payload); setError(''); }, reason => setError(reason.message), name ? 30_000 : 10_000);
  const command = async (kind: BackupCommand) => {
    if (readOnly || busy) return;
    if (kind !== 'create' && !await confirm(backupConfirmation(kind, name, objectName))) return;
    const id = crypto.randomUUID(); setJobId(id); setBusy(true); setError(''); setMessage('Auftrag wird gesendet. Bei Verbindungsabbruch ausschließlich den Auftragsstatus prüfen.');
    const request = backupRequest(kind, id, name, objectName);
    try {
      const response = await jsonRequest(request.endpoint, request.init);
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

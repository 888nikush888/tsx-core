import { useCallback, useState } from 'react';
import { jsonRequest } from '@/lib/api';
import { usePoll } from '@/shared/api/use-poll';
import { EvidenceFields, EvidenceTable } from '@/shared/components/evidence';

type KernelLimitEvidence = { source: string; value: string };
type DeploymentDeclaration = { name: string; value: string | null; source: string; interpretation: string };
type TlsCertificate = { fingerprint256: string; subjectAltName: string | null; expiresAt: string };
type TlsEndpoint = {
  id: string; label: string;
  file: { state: string; certificate: TlsCertificate | null };
  active: { state: string; certificate: TlsCertificate | null; checkedAt: number | null };
  activeMatchesFile: boolean | null;
};
type TlsObservation = {
  trustAnchor: { state: string; certificates: TlsCertificate[]; earliestExpiryAt: string | null };
  endpoints: TlsEndpoint[];
  interpretation: string;
};

interface DeploymentObservation {
  observedAt: number;
  listener: { address?: string; port?: number; source: string; interpretation: string };
  process: {
    platform: string; nodeVersion: string; availableCpuParallelism: number;
    operatingSystemMemoryBytes: string; source: string; interpretation: string;
  };
  limits: { memory: KernelLimitEvidence | null; cpu: KernelLimitEvidence | null; interpretation: string };
  declarations: DeploymentDeclaration[];
  tls?: TlsObservation;
  boundary: string;
}

export function DeploymentEvidence() {
  const [data, setData] = useState<DeploymentObservation | null>(null); const [error, setError] = useState('');
  const read = useCallback((signal: AbortSignal) => jsonRequest('/api/ui/deployment', { signal }), []);
  usePoll(read, value => { setData(value); setError(''); }, failure => setError(failure.message), 30000);
  const build = { uiVersion: __UI_VERSION__, basename: import.meta.env.VITE_BASENAME || '', gtmConfigured: Boolean(import.meta.env.VITE_GTM_ID), production: import.meta.env.PROD };
  return <section className="operations-card space-y-4"><h2>Deployment und Browserbuild</h2>
    <EvidenceFields fields={[["UI-Version", build.uiVersion], ['Basispfad dieses Builds', build.basename || '/'], ['GTM im Build konfiguriert', build.gtmConfigured], ['Produktionsbuild', build.production], ['Vom Browser verwendeter Ursprung', window.location.origin]]} />
    <p>Quelle: tatsächlich geladener Browserbuild und aktuelle Browseradresse. Der vorhandene GTM-Pfad wird nur bei Produktionsbuild und konfigurierter ID aufgerufen; diese Angabe beweist keine erfolgreiche Übertragung.</p>
    {error && <p role="alert">{error} · Deploymentbeobachtung möglicherweise veraltet.</p>}
    {data ? <ServerDeploymentEvidence data={data} /> : <p><output>Serverquellen werden gelesen …</output></p>}
  </section>;
}

function ServerDeploymentEvidence({ data }: Readonly<{ data: DeploymentObservation }>) {
  return <><EvidenceFields fields={[["Serverbeobachtung", new Date(data.observedAt).toLocaleString('de-DE')], ['Interner Listener', `${data.listener.address ?? 'unbekannt'}:${data.listener.port ?? 'unbekannt'}`], ['Node-Version', data.process.nodeVersion], ['Betriebssystem', data.process.platform], ['CPU-Parallelität laut Betriebssystem', data.process.availableCpuParallelism], ['RAM laut Betriebssystem (Bytes)', data.process.operatingSystemMemoryBytes], ['Sichtbares cgroup-RAM-Limit (Bytes oder max)', data.limits.memory?.value], ['Sichtbare cgroup-CPU-Quote / Periode (µs)', data.limits.cpu?.value]]} />
      <p>{data.listener.interpretation}</p><p>{data.process.interpretation}</p><p>{data.limits.interpretation}</p>
      <EvidenceTable caption="Im Prozess vorhandene Deploymentdeklarationen" rows={data.declarations} columns={[["name", "Wertname"], ["value", "Deklarierter Wert"], ["source", "Tatsächliche Quelle"]]} />
      {data.tls ? <TlsDeploymentEvidence tls={data.tls} /> : <p>TLS-Deploymentstatus wird von dieser Serverversion nicht bereitgestellt.</p>}
      <p>Fehlende Deklarationen bedeuten unbekannt. Der Core liest keine Compose-Datei und bestätigt damit weder Hostports noch Ressourcenlimits.</p><p>{data.boundary}</p>
    </>;
}

const fileState: Record<string, string> = {
  available: 'Datei lesbar und zeitlich gültig', not_configured: 'nicht konfiguriert', not_visible: 'Datei in diesem Dienst nicht sichtbar',
  missing: 'Datei fehlt', invalid: 'Datei ungültig', expired: 'Zertifikat abgelaufen', not_yet_valid: 'noch nicht gültig',
  expiring_soon: 'weniger als eine Stunde gültig',
};
const activeState: Record<string, string> = {
  observed: 'TLS aktiv beobachtet', unreachable: 'nicht erreichbar', untrusted: 'TLS-Vertrauen fehlgeschlagen', not_checked: 'nicht geprüft',
};

function TlsDeploymentEvidence({ tls }: Readonly<{ tls: TlsObservation }>) {
  const rows = tls.endpoints.map(endpoint => ({
    id: endpoint.id,
    service: endpoint.label,
    file: fileState[endpoint.file.state] || 'unbekannt',
    active: activeState[endpoint.active.state] || 'unbekannt',
    activeFingerprint: endpoint.active.certificate?.fingerprint256,
    fileFingerprint: endpoint.file.certificate?.fingerprint256,
    activeSan: endpoint.active.certificate?.subjectAltName,
    fileSan: endpoint.file.certificate?.subjectAltName,
    activeExpiry: endpoint.active.certificate?.expiresAt,
    fileExpiry: endpoint.file.certificate?.expiresAt,
    checkedAt: endpoint.active.checkedAt ? new Date(endpoint.active.checkedAt).toLocaleString('de-DE') : null,
    match: endpoint.activeMatchesFile === null ? 'nicht vergleichbar' : endpoint.activeMatchesFile ? 'ja' : 'nein – Datei und Listener weichen ab',
  }));
  return <section aria-label="Interne TLS-Verbindungen" className="space-y-3">
    <h3>Interne TLS-Verbindungen</h3>
    <EvidenceFields fields={[["CA-Bundle", fileState[tls.trustAnchor.state] || 'unbekannt'],
      ['Anzahl CA-Zertifikate', tls.trustAnchor.certificates.length],
      ['Frühester CA-Ablauf', tls.trustAnchor.earliestExpiryAt]]} />
    <EvidenceTable caption="CA-Zertifikate im Vertrauensbundle" rows={tls.trustAnchor.certificates.map((certificate, index) => ({
      id: `ca-${index}`, number: index + 1, fingerprint: certificate.fingerprint256, expiresAt: certificate.expiresAt,
    }))} columns={[["number", "Nr."], ["fingerprint", "CA-Fingerabdruck (SHA-256)"], ["expiresAt", "Gültig bis"]]} />
    <EvidenceTable caption="TLS-Zertifikate der fünf internen Wege" rows={rows} columns={[
      ['service', 'Verbindung'], ['file', 'Dateistand'], ['active', 'Aktiver TLS-Status'],
      ['activeFingerprint', 'Aktiver Fingerabdruck'], ['fileFingerprint', 'Datei-Fingerabdruck'],
      ['activeSan', 'Aktive SAN'], ['fileSan', 'Datei-SAN'],
      ['activeExpiry', 'Aktiv gültig bis'], ['fileExpiry', 'Datei gültig bis'],
      ['checkedAt', 'TLS-Prüfung'], ['match', 'Aktiv entspricht Datei'],
    ]} />
    <p>{tls.interpretation} Die CA-Fingerabdrücke beschreiben die aktuell lesbare Datei; andere Prozesse übernehmen eine Änderung gegebenenfalls erst nach Neustart. Die vollständige SAN-, Schlüssel-, Ketten- und Dateiberechtigungsprüfung erfolgt im TLS-Preflight.</p>
    <p>Die Zertifikatsverwaltung und Rotation erfolgen derzeit außerhalb dieser Ansicht. Hier werden keine privaten Schlüssel oder Dateipfade angezeigt.</p>
  </section>;
}

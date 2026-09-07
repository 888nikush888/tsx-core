import { useCallback, useState } from 'react';
import { jsonRequest } from '@/lib/api';
import { usePoll } from '@/shared/api/use-poll';
import { EvidenceFields, EvidenceTable } from '@/shared/components/evidence';

export function DeploymentEvidence() {
  const [data, setData] = useState<any>(null); const [error, setError] = useState('');
  const read = useCallback((signal: AbortSignal) => jsonRequest('/api/ui/deployment', { signal }), []);
  usePoll(read, value => { setData(value); setError(''); }, failure => setError(failure.message), 30000);
  const build = { uiVersion: __UI_VERSION__, basename: import.meta.env.VITE_BASENAME || '', gtmConfigured: Boolean(import.meta.env.VITE_GTM_ID), production: import.meta.env.PROD };
  return <section className="operations-card space-y-4"><h2>Deployment und Browserbuild</h2>
    <EvidenceFields fields={[["UI-Version", build.uiVersion], ['Basispfad dieses Builds', build.basename || '/'], ['GTM im Build konfiguriert', build.gtmConfigured], ['Produktionsbuild', build.production], ['Vom Browser verwendeter Ursprung', window.location.origin]]} />
    <p>Quelle: tatsächlich geladener Browserbuild und aktuelle Browseradresse. Der vorhandene GTM-Pfad wird nur bei Produktionsbuild und konfigurierter ID aufgerufen; diese Angabe beweist keine erfolgreiche Übertragung.</p>
    {error && <p role="alert">{error} · Deploymentbeobachtung möglicherweise veraltet.</p>}
    {data ? <><EvidenceFields fields={[["Serverbeobachtung", new Date(data.observedAt).toLocaleString('de-DE')], ['Interner Listener', `${data.listener.address ?? 'unbekannt'}:${data.listener.port ?? 'unbekannt'}`], ['Node-Version', data.process.nodeVersion], ['Betriebssystem', data.process.platform], ['CPU-Parallelität laut Betriebssystem', data.process.availableCpuParallelism], ['RAM laut Betriebssystem (Bytes)', data.process.operatingSystemMemoryBytes], ['Sichtbares cgroup-RAM-Limit (Bytes oder max)', data.limits.memory?.value], ['Sichtbare cgroup-CPU-Quote / Periode (µs)', data.limits.cpu?.value]]} />
      <p>{data.listener.interpretation}</p><p>{data.process.interpretation}</p><p>{data.limits.interpretation}</p>
      <EvidenceTable caption="Im Prozess vorhandene Deploymentdeklarationen" rows={data.declarations} columns={[["name", "Wertname"], ["value", "Deklarierter Wert"], ["source", "Tatsächliche Quelle"]]} />
      <p>Fehlende Deklarationen bedeuten unbekannt. Der Core liest keine Compose-Datei und bestätigt damit weder Hostports noch Ressourcenlimits.</p><p>{data.boundary}</p>
    </> : <p><output>Serverquellen werden gelesen …</output></p>}
  </section>;
}

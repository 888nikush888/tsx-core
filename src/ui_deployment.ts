import { readFile } from 'node:fs/promises';
import { availableParallelism, platform, totalmem } from 'node:os';

async function kernelLimit(file: string, pattern: RegExp) {
  try {
    const value = (await readFile(file, { encoding: 'utf8' })).trim();
    return pattern.test(value) ? { source: file, value } : null;
  } catch { return null; }
}

/** Only fixed kernel paths and explicitly named non-secret deployment declarations are exposed. */
export async function uiDeployment(listener: { address: string | undefined; port: number | undefined }) {
  const [memory, cpu] = await Promise.all([
    kernelLimit('/sys/fs/cgroup/memory.max', /^(max|\d{1,20})$/),
    kernelLimit('/sys/fs/cgroup/cpu.max', /^(max|\d{1,20}) \d{1,20}$/),
  ]);
  const declarations = ['HOST_WEB_PORT', 'HOST_METRICS_PORT', 'HOST_MCP_PORT', 'FORWARDER_MEMORY_LIMIT', 'FORWARDER_CPU_LIMIT', 'MCP_MEMORY_LIMIT', 'MCP_CPU_LIMIT'].map(name => ({
    name, source: `process.env.${name}`, value: process.env[name]?.slice(0, 64) ?? null,
    interpretation: 'Nur im Prozess vorhandene Deklaration; keine Beobachtung der tatsächlichen Host-/Compose-Zuordnung.',
  }));
  return { contractVersion: 1, observedAt: Date.now(), readOnly: true,
    listener: { ...listener, source: 'Aktuelle HTTP-Verbindung: serverseitiger Socket', interpretation: 'Interner Listener. Proxy und veröffentlichter Hostport können abweichen.' },
    process: { platform: platform(), nodeVersion: process.version, availableCpuParallelism: availableParallelism(), operatingSystemMemoryBytes: String(totalmem()), source: 'Node os.availableParallelism / os.totalmem', interpretation: 'Betriebssystembeobachtung, kein garantierter Container- oder Hostvertrag.' },
    limits: { memory, cpu, interpretation: 'Linux cgroup v2 des sichtbaren Wurzelkontexts. max bedeutet dort unbegrenzt; übergeordnete Limits können zusätzlich gelten. Nicht lesbare Limits sind unbekannt.' },
    declarations,
    boundary: 'Host-Ports, CPU/RAM-Limits und Imagewechsel werden im Deployment geändert. UI-Buildflags wirken nach neuem Build. Ein gestoppter Core kann keinen Offline-Restore oder eigenen Wiederanlauf ausführen.' };
}

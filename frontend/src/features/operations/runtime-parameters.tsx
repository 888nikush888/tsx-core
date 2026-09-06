import { EvidenceFields } from '@/shared/components/evidence';
import { useSettingFocus } from '@/shared/forms/use-setting-focus';

type Parameter = { path: string; group: string; type: string; unit: string | null; default: unknown; range: [number, number] | null; values: string[] | null; maxLength: number; nullable: boolean; editable: boolean; secret: boolean; environmentName: string; source: string; requiresRestart: boolean };
const labels: Record<string, string> = { dashboardAuthMode: 'Authentifizierung', dashboardLocalTrust: 'Lokale Vertrauenssitzung', dashboardAllowedOrigin: 'Erlaubter Browser-Ursprung', tailscaleServeTrustedProxy: 'Tailscale-Serve-Proxy vertrauen', tailscaleAdminUsers: 'Tailscale Admin-Logins', tailscaleViewerUsers: 'Tailscale Viewer-Logins', enterpriseMode: 'Enterprise-Modus' };
export function runtimeInputError(value: Record<string, any>, parameters: Parameter[] | undefined): string | null {
  if (!parameters) return 'Parametervertrag fehlt. Eine kompatible Server-/UI-Version ist erforderlich.';
  for (const field of parameters) {
    if (!field.editable || field.secret) continue;
    const current = value[field.path];
    if (!['string', 'number', 'boolean'].includes(field.type) || typeof current !== field.type) return `${field.path}: unbekannter oder falscher Feldtyp.`;
    if (field.type === 'number' && (!Number.isSafeInteger(current) || field.range && (current < field.range[0] || current > field.range[1]))) return `${field.path}: ganze Zahl ${field.range?.join(' bis ') ?? ''} erforderlich.`;
    if (field.type === 'string' && (current.length > field.maxLength || field.values && !field.values.includes(current))) return `${field.path}: nicht erlaubter Wert.`;
  }
  return null;
}

export function RuntimeParameters({ value, onChange, payload, readOnly = false }: { value: Record<string, any>; onChange: (value: Record<string, any>) => void; payload: any; readOnly?: boolean }) {
  const parameters = (payload?.parameters ?? []) as Parameter[];
  useSettingFocus(parameters.map(field => `runtime.${field.path}`));
  const groups = [...new Set(parameters.map(item => item.group))];
  const display = (item: unknown) => item === undefined ? 'nicht beobachtet' : item === null ? 'null' : item === '' ? 'leer' : typeof item === 'boolean' ? item ? 'ja' : 'nein' : String(item);
  return <div className="operations-stack"><p>Gespeicherte Runtime-Werte ersetzen beim Start die zugeordneten Umgebungswerte. Änderungen an Zugriffsrechten können bestehende Sitzungen sofort widerrufen. Enterprise erfordert OIDC, entfernten Audit- und Offsite-Nachweis; abhängige Felder ausdrücklich mit konfigurieren.</p>
    <EvidenceFields fields={[["Quelle", payload?.source], ["Neustart erforderlich", payload?.restartRequired], ["Gespeicherte Revision", payload?.revision]]} />
    {!parameters.length && <p role="alert">Parametervertrag fehlt. Die Runtime bleibt schreibgeschützt, bis eine kompatible Serverversion die Typen und Grenzen liefert.</p>}
    {groups.map(group => <fieldset key={group} className="system-form"><legend>{group}</legend><div className="builder-field-grid">{parameters.filter(item => item.group === group).map(field => {
      const known = ['string', 'number', 'boolean'].includes(field.type); const disabled = readOnly || !field.editable || field.secret || !known;
      return <label key={field.path} id={`setting-runtime.${field.path}`}>{labels[field.path] ?? field.path}{field.unit ? ` (${field.unit})` : ''}
        {field.type === 'boolean' ? <input type="checkbox" disabled={disabled} checked={value[field.path] === true} onChange={event => onChange({ ...value, [field.path]: event.target.checked })} />
          : field.values ? <select disabled={disabled} value={value[field.path] ?? ''} onChange={event => onChange({ ...value, [field.path]: event.target.value })}>{field.values.map(item => <option key={item}>{item}</option>)}</select>
            : <input disabled={disabled} type={field.type === 'number' ? 'number' : 'text'} step={field.type === 'number' ? 1 : undefined} min={field.range?.[0]} max={field.range?.[1]} maxLength={field.maxLength}
              value={known && !field.secret ? Number.isNaN(value[field.path]) ? '' : value[field.path] ?? '' : 'Unbekannter Feldtyp / schreibgeschützt'} onChange={event => onChange({ ...value, [field.path]: field.type === 'number' ? event.target.value === '' ? NaN : Number(event.target.value) : event.target.value })} />}
        <small>{field.path} · {field.environmentName}<br />Gespeichert: {display(payload?.settings?.[field.path])} · aktiv beim Start: {display(payload?.active?.[field.path])}<br />Default: {display(field.default)}{field.range ? ` · Grenze ${field.range.join('–')}` : ''}<br />{field.type === 'string' ? 'Leer löscht optionale Werte; erforderliche Profilfelder werden gemeinsam geprüft. ' : '0 und false bleiben ausdrückliche Werte. '}{field.requiresRestart ? 'Aktivierung nach Neustart.' : 'Sofort wirksam.'}</small>
      </label>;
    })}</div></fieldset>)}
    {Object.keys(value).filter(key => !parameters.some(item => item.path === key)).length > 0 && <details><summary>Unbekannte Serverfelder · unverändert und schreibgeschützt</summary>{Object.keys(value).filter(key => !parameters.some(item => item.path === key)).map(key => <p key={key}>{key}: {display(value[key])}</p>)}</details>}
  </div>;
}

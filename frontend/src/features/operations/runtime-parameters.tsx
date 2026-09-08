import { valueText } from "@/shared/value-text";
import { EvidenceFields } from '@/shared/components/evidence';
import { useSettingFocus } from '@/shared/forms/use-setting-focus';

type Parameter = { path: string; group: string; type: string; unit: string | null; default: unknown; range: [number, number] | null; values: string[] | null; maxLength: number; nullable: boolean; editable: boolean; secret: boolean; environmentName: string; source: string; requiresRestart: boolean };
interface RuntimeParameterPayload {
  parameters?: Parameter[];
  source?: string;
  restartRequired?: boolean;
  revision?: string;
  settings?: Record<string, unknown>;
  active?: Record<string, unknown> | null;
}

const labels: Record<string, string> = { dashboardAuthMode: 'Authentifizierung', dashboardLocalTrust: 'Lokale Vertrauenssitzung', dashboardAllowedOrigin: 'Erlaubter Browser-Ursprung', tailscaleServeTrustedProxy: 'Tailscale-Serve-Proxy vertrauen', tailscaleAdminUsers: 'Tailscale Admin-Logins', tailscaleViewerUsers: 'Tailscale Viewer-Logins', enterpriseMode: 'Enterprise-Modus' };
function invalidRuntimeNumber(value: number, range: Parameter['range']) {
  if (!Number.isSafeInteger(value)) return true;
  return Boolean(range && (value < range[0] || value > range[1]));
}
function invalidRuntimeString(value: string, field: Parameter) {
  return value.length > field.maxLength || Boolean(field.values && !field.values.includes(value));
}
function runtimeNumberError(value: number, field: Parameter): string | null {
  if (invalidRuntimeNumber(value, field.range)) return `${field.path}: ganze Zahl ${field.range?.join(' bis ') ?? ''} erforderlich.`;
  return null;
}
function runtimeStringError(value: string, field: Parameter): string | null {
  if (invalidRuntimeString(value, field)) return `${field.path}: nicht erlaubter Wert.`;
  return null;
}
function runtimeValueError(value: unknown, field: Parameter): string | null {
  if (!['string', 'number', 'boolean'].includes(field.type) || typeof value !== field.type) return `${field.path}: unbekannter oder falscher Feldtyp.`;
  if (typeof value === 'number') return runtimeNumberError(value, field);
  if (typeof value === 'string') return runtimeStringError(value, field);
  return null;
}
function editableRuntimeError(value: Record<string, unknown>, field: Parameter): string | null {
  if (!field.editable || field.secret) return null;
  return runtimeValueError(value[field.path], field);
}
export function runtimeInputError(value: Record<string, unknown>, parameters: Parameter[] | undefined): string | null {
  if (!parameters) return 'Parametervertrag fehlt. Eine kompatible Server-/UI-Version ist erforderlich.';
  for (const field of parameters) {
    const error = editableRuntimeError(value, field);
    if (error) return error;
  }
  return null;
}

function runtimeFieldValue(field: Parameter, value: any) {
  if (field.secret || !['string', 'number', 'boolean'].includes(field.type)) return 'Unbekannter Feldtyp / schreibgeschützt';
  return Number.isNaN(value) ? '' : value ?? '';
}
function parseRuntimeField(field: Parameter, value: string) {
  if (field.type !== 'number') return value;
  return value === '' ? Number.NaN : Number(value);
}

function runtimeBooleanText(value: boolean) {
  return value ? 'ja' : 'nein';
}
function runtimeEvidenceText(item: unknown) {
  if (item === undefined) {
    return 'nicht beobachtet';
  }
  if (item === null) {
    return 'null';
  }
  if (item === '') {
    return 'leer';
  }
  if (typeof item === 'boolean') {
    return runtimeBooleanText(item);
  }
  return valueText(item);
}

export function RuntimeParameters({ value, onChange, payload, readOnly = false }: Readonly<{ value: Record<string, any>; onChange: (value: Record<string, any>) => void; payload: RuntimeParameterPayload | null; readOnly?: boolean }>) {
  const parameters = payload?.parameters ?? [];
  useSettingFocus(parameters.map(field => `runtime.${field.path}`));
  const groups = [...new Set(parameters.map(item => item.group))];
  return <div className="operations-stack"><p>Gespeicherte Runtime-Werte ersetzen beim Start die zugeordneten Umgebungswerte. Änderungen an Zugriffsrechten können bestehende Sitzungen sofort widerrufen. Enterprise erfordert OIDC, entfernten Audit- und Offsite-Nachweis; abhängige Felder ausdrücklich mit konfigurieren.</p>
    <EvidenceFields fields={[["Quelle", payload?.source], ["Neustart erforderlich", payload?.restartRequired], ["Gespeicherte Revision", payload?.revision]]} />
    {!parameters.length && <p role="alert">Parametervertrag fehlt. Die Runtime bleibt schreibgeschützt, bis eine kompatible Serverversion die Typen und Grenzen liefert.</p>}
    {groups.map(group => <fieldset key={group} className="system-form"><legend>{group}</legend><div className="builder-field-grid">{parameters.filter(item => item.group === group).map(field => {
      const known = ['string', 'number', 'boolean'].includes(field.type); const disabled = readOnly || !field.editable || field.secret || !known;
      const parameterControl = () => {
        if (field.type === 'boolean') {
          return <input type="checkbox" disabled={disabled} checked={value[field.path] === true} onChange={event => onChange({ ...value, [field.path]: event.target.checked })} />;
        }
        if (field.values) {
          return <select disabled={disabled} value={value[field.path] ?? ''} onChange={event => onChange({ ...value, [field.path]: event.target.value })}>{field.values.map(item => <option key={item}>{item}</option>)}</select>;
        }
        return <input disabled={disabled} type={field.type === 'number' ? 'number' : 'text'} step={field.type === 'number' ? 1 : undefined} min={field.range?.[0]} max={field.range?.[1]} maxLength={field.maxLength}
          value={runtimeFieldValue(field, value[field.path])} onChange={event => onChange({ ...value, [field.path]: parseRuntimeField(field, event.target.value) })} />;
      };
      return <label key={field.path} id={`setting-runtime.${field.path}`}>{labels[field.path] ?? field.path}{field.unit ? ` (${field.unit})` : ''}
        {parameterControl()}
        <small>{field.path} · {field.environmentName}<br />Gespeichert: {runtimeEvidenceText(payload?.settings?.[field.path])} · aktiv beim Start: {runtimeEvidenceText(payload?.active?.[field.path])}<br />Default: {runtimeEvidenceText(field.default)}{field.range ? ` · Grenze ${field.range.join('–')}` : ''}<br />{field.type === 'string' ? 'Leer löscht optionale Werte; erforderliche Profilfelder werden gemeinsam geprüft. ' : '0 und false bleiben ausdrückliche Werte. '}{field.requiresRestart ? 'Aktivierung nach Neustart.' : 'Sofort wirksam.'}</small>
      </label>;
    })}</div></fieldset>)}
    {Object.keys(value).some(key => !parameters.some(item => item.path === key)) && <details><summary>Unbekannte Serverfelder · unverändert und schreibgeschützt</summary>{Object.keys(value).filter(key => !parameters.some(item => item.path === key)).map(key => <p key={key}>{key}: {runtimeEvidenceText(value[key])}</p>)}</details>}
  </div>;
}

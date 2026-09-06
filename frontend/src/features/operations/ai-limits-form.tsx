import { AI_LIMIT_LABELS, AI_LIMIT_RANGES } from "../../../../src/ui_contracts";
import { useSettingFocus } from '@/shared/forms/use-setting-focus';

export function AiLimitsForm({ value, onChange }: { value: Record<string, number>; onChange: (value: Record<string, number>) => void }) {
  useSettingFocus(Object.keys(AI_LIMIT_RANGES).map(key => `ai.${key}`));
  return <fieldset className="system-form"><legend>Globale KI-Limits</legend>
    <p>Quelle: globale Konfiguration. Wirksam für künftige Anfragen; Parserbausteine können eigene Modelle und Zeitlimits vorgeben. Tagesverbrauch verwendet UTC.</p>
    <div className="builder-field-grid">{Object.entries(AI_LIMIT_RANGES).map(([key, [min, max]]) => {
      const [label, unit] = AI_LIMIT_LABELS[key as keyof typeof AI_LIMIT_LABELS];
      return <label key={key} id={`setting-ai.${key}`}>{label} ({unit})<input type="number" min={min} max={max} step={1} required
        value={value[key] ?? ""} onChange={(event) => onChange({ ...value, [key]: event.target.value === "" ? NaN : Number(event.target.value) })} />
        <small>{min} bis {max}</small></label>;
    })}</div>
  </fieldset>;
}

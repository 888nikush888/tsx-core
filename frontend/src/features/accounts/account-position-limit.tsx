import { useState } from 'react';
import type { TradingAccount } from '@/app/workflow/types';
import { useVersionedDraft } from '@/shared/forms/use-versioned-draft';
import { DraftState } from '@/shared/forms/draft-state';

export function AccountPositionLimit({ account, disabled, onSave }: Readonly<{ account: TradingAccount; disabled: boolean; onSave: (maximum: number, baseUpdatedAt?: number) => Promise<any> }>) {
  const form = useVersionedDraft(account.id, { maximum: account.maxConcurrentPositions }, account.updatedAt ?? account.maxConcurrentPositions, { maximum: account.maxConcurrentPositions });
  const [message, setMessage] = useState(''); const [busy, setBusy] = useState(false);
  const maximum = form.draft.maximum;
  const valid = Number.isSafeInteger(maximum) && maximum >= 1 && maximum <= 20;
  const save = async () => {
    if (disabled || busy || form.conflict || !valid) return;
    setBusy(true); setMessage('');
    try {
      const result = await onSave(maximum, account.updatedAt === undefined ? undefined : Number(form.baseRevision));
      if (!result) throw new Error('Der Server hat die Änderung nicht bestätigt. Aktuellen Kontostand prüfen.');
      const accepted = result?.account ?? result?.result ?? result;
      form.saved({ maximum: accepted?.maxConcurrentPositions ?? maximum }, accepted?.updatedAt ?? form.baseRevision);
      setMessage('Konto-Limit bestätigt. Gilt sofort für das gesamte Konto und alle Pfade; vorhandene Positionen werden nicht geschlossen.');
    } catch (reason) { setMessage(`Limit nicht bestätigt; keine automatische Wiederholung: ${reason instanceof Error ? reason.message : String(reason)}`); }
    finally { setBusy(false); }
  };
  return <div className="account-limit-editor system-form"><label>Positionslimit<input type="number" min={1} max={20} step={1} value={Number.isNaN(maximum) ? '' : maximum} disabled={disabled || busy} onChange={event => form.setDraft({ maximum: event.target.value === '' ? Number.NaN : Number(event.target.value) })} /></label>
    <p>1–20 Positionen / Reservierungen · gemeinsames Kontolimit über alle Strategien und Pfade. Wirkt unabhängig von Ressourcenpublikation und Graphaktivierung.</p>
    <DraftState label={`Positionslimit ${account.name}`} form={form} server={{ maximum: account.maxConcurrentPositions }} />
    <button type="button" className="secondary-button" disabled={disabled || busy || !valid || !form.dirty || form.conflict} onClick={() => { save(); }}>Limit speichern</button>
    {message && <p><output>{message}</output></p>}
  </div>;
}

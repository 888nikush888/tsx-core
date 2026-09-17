import { useCallback, useEffect, useRef, useState } from 'react';
import { jsonRequest, mutateAndObserve } from '@/lib/api';
import { usePoll } from '@/shared/api/use-poll';
import { decimalInput } from '@/shared/forms/decimal-input';
import { useConfirmationDialog } from '@/components/confirmation-dialog';
import { EvidenceFields, EvidenceTable } from '@/shared/components/evidence';
import { useVersionedDraft } from '@/shared/forms/use-versioned-draft';
import { DraftState } from '@/shared/forms/draft-state';
import { ChangeReview } from '@/shared/components/change-review';

const MARKET_FIELDS = [['markPrice', 'Markpreis'], ['priceTick', 'Preistick'], ['quantityStep', 'Mengenschritt'], ['minimumQuantity', 'Mindestmenge'], ['minimumNotional', 'Mindestnotional']] as const;
const EMPTY_MARKET = { symbol: '', markPrice: '', priceTick: '', quantityStep: '', minimumQuantity: '', minimumNotional: '', maxLeverage: 1 };
type MarketDraft = typeof EMPTY_MARKET;
type BalanceDraft = { equity: string; availableBalance: string };
type EditorValues = MarketDraft | BalanceDraft;
type PaperRecord = Partial<MarketDraft & BalanceDraft> & { accountId: string; revision?: string | null; source?: string; reportingCurrency?: string; updatedAt?: number };
type PaperMarket = PaperRecord & MarketDraft;
type PaperBalance = PaperRecord & BalanceDraft;
type PaperAccount = { id: string; name: string; exchange: string; mode: string };
type PaperResult = { accountId: string; market?: PaperMarket | null; balance?: PaperBalance | null };
type PaperSnapshot = { accounts: PaperAccount[]; activity: { paperMarkets: PaperMarket[]; paperAccounts?: PaperBalance[] } };
type SavePayload = { accountId: string; baseMarketRevision?: string | number | null; baseBalanceRevision?: string | number | null; market?: unknown; equity?: string; availableBalance?: string };
type SaveReceipt = { before: unknown; after: EditorValues | null };
function values(kind: 'market' | 'balance', row: PaperRecord | null | undefined): EditorValues {
  const fields = kind === 'market' ? Object.keys(EMPTY_MARKET) : ['equity', 'availableBalance'];
  return Object.fromEntries(fields.map(key => [key, row?.[key as keyof (MarketDraft & BalanceDraft)] ?? (kind === 'market' ? (EMPTY_MARKET as Partial<Record<string, string | number>>)[key] : '')])) as EditorValues;
}
function PaperEditorFields({ kind, record, form, readOnly, busy, save }: Readonly<{
  kind: 'market' | 'balance'; record: PaperRecord | null; form: ReturnType<typeof useVersionedDraft<EditorValues>>;
  readOnly: boolean; busy: boolean; save: () => void | Promise<void>;
}>) {
  return (
    <fieldset disabled={readOnly || busy || Boolean(record && !record.revision) || (kind === 'balance' && !record)}><div className="builder-field-grid">
      {kind === 'market' ? <><label>Symbol<input readOnly={Boolean(record)} value={(form.draft as MarketDraft).symbol} onChange={event => form.setDraft({ ...form.draft, symbol: event.target.value })} placeholder="Beispiel: BTCUSDT" /></label>{MARKET_FIELDS.map(([key, label]) => <label key={key}>{label}<input inputMode="decimal" value={(form.draft as MarketDraft)[key]} onChange={event => form.setDraft({ ...form.draft, [key]: event.target.value })} /></label>)}<label>Maximaler Hebel<input type="number" min={1} max={125} step={1} value={(form.draft as MarketDraft).maxLeverage} onChange={event => form.setDraft({ ...form.draft, maxLeverage: Number(event.target.value) })} /></label></>
        : <><label>Basis-Eigenkapital ({record?.reportingCurrency ?? 'Währung unbekannt'})<input inputMode="decimal" value={(form.draft as BalanceDraft).equity} onChange={event => form.setDraft({ ...form.draft, equity: event.target.value })} /></label><label>Verfügbarer Basisbestand ({record?.reportingCurrency ?? 'Währung unbekannt'})<input inputMode="decimal" value={(form.draft as BalanceDraft).availableBalance} onChange={event => form.setDraft({ ...form.draft, availableBalance: event.target.value })} /></label></>}
    </div><button className="primary-button" disabled={form.conflict} onClick={() => { save(); }}>{kind === 'market' ? 'Paper-Markt speichern' : 'Paper-Bestand setzen'}</button></fieldset>
  );
}

function PaperBalanceEvidence({ kind, record }: Readonly<{ kind: 'market' | 'balance'; record: PaperRecord | null }>) {
  if (kind !== 'balance') return null;
  return (
    <>
      <p>Quelle: {record?.source ?? 'unbekannt'} · Währung: {record?.reportingCurrency ?? 'unbekannt'}. Die gespeicherten Basisbestände enthalten keine zusätzliche Marktbewertung offener Positionen.</p><EvidenceFields fields={[["Beobachtete Revision", record?.revision], ["Basis-Eigenkapital", record?.equity], ["Verfügbarer Basisbestand", record?.availableBalance], ["Stand (Unix ms)", record?.updatedAt]]} />
    </>
  );
}

function PaperReceipt({ receipt }: Readonly<{ receipt: SaveReceipt | null }>) {
  return (
    <>
    {receipt && (receipt.after ? <ChangeReview {...receipt} label="Bestätigte Paper-Normalisierung" /> : <p><output>Änderung angenommen; bestätigte Werte fehlen im Antwortvertrag. Aktuellen Stand vor einem weiteren Schreibvorgang prüfen.</output></p>)}
    </>
  );
}

function PaperEditor({ kind, account, record, readOnly, accepted, refresh, onState }: Readonly<{ kind: 'market' | 'balance'; account: PaperAccount; record: PaperRecord | null; readOnly: boolean; accepted: (result: PaperResult | null | undefined, kind: 'market' | 'balance') => void; refresh: () => Promise<void>; onState: (kind: string, dirty: boolean, busy: boolean) => void }>) {
  const form = useVersionedDraft(`${kind}:${account.id}:${record?.symbol ?? 'new'}`, values(kind, record), record?.revision ?? null, values(kind, null));
  const [busy, setBusy] = useState(false); const [error, setError] = useState(''); const [receipt, setReceipt] = useState<SaveReceipt | null>(null);
  useEffect(() => { onState(kind, form.dirty, busy); return () => onState(kind, false, false); }, [kind, form.dirty, busy, onState]);
  const { confirm, confirmationDialog } = useConfirmationDialog();
  const save = async () => {
    if (readOnly || form.conflict || record && !record.revision) return;
    let payload: SavePayload;
    try {
      payload = kind === 'market' ? { accountId: account.id, baseMarketRevision: form.baseRevision, market: { ...form.draft, symbol: (form.draft as MarketDraft).symbol.trim().toUpperCase().replaceAll('/', ''), ...Object.fromEntries(MARKET_FIELDS.map(([key]) => [key, decimalInput((form.draft as MarketDraft)[key])])) } }
        : { accountId: account.id, baseBalanceRevision: form.baseRevision, equity: decimalInput((form.draft as BalanceDraft).equity), availableBalance: decimalInput((form.draft as BalanceDraft).availableBalance) };
    } catch (reason) { setError(String(reason)); return; }
    if (!await confirm({ title: kind === 'market' ? 'Paper-Markt ändern' : 'Paper-Bestand setzen', description: `Nur simuliertes Konto ${account.name} (${account.id}). ${kind === 'market' ? 'Der neue Kurs kann vorhandene simulierte Orders ausführen und Stop-/TP-Ereignisse auslösen.' : 'Die Basisbestände werden ersetzt. Offener PnL wird in der Kontobewertung zusätzlich berücksichtigt; Risikoprüfungen künftiger Paper-Entries ändern sich.'}`, confirmLabel: 'Paper-Änderung speichern' })) return;
    setBusy(true); setError('');
    try {
      const result = await mutateAndObserve(() => jsonRequest('/api/trading/paper', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) }), response => {
        const row = response.result?.[kind];
        if (row?.revision) form.saved(values(kind, row), row.revision);
        setReceipt({ before: kind === 'market' ? payload.market : { equity: payload.equity, availableBalance: payload.availableBalance }, after: row ? values(kind, row) : null });
        accepted(response.result, kind);
      }, refresh);
      if (result.refreshError) setError(`Änderung bestätigt; Nachladen fehlgeschlagen: ${result.refreshError}`);
    } catch (reason) { setError(`Änderung nicht bestätigt. Keine automatische Wiederholung: ${reason instanceof Error ? reason.message : String(reason)}`); }
    finally { setBusy(false); }
  };

  return <section className="operations-card system-form">{confirmationDialog}<h2>{kind === 'market' ? 'Simulierten Markt bearbeiten' : 'Simulierten Basisbestand setzen'}</h2>
    {error && <p role="alert">{error}</p>}<DraftState label={kind === 'market' ? 'Paper-Markt' : 'Paper-Bestand'} form={form} server={values(kind, record)} />
    <PaperBalanceEvidence kind={kind} record={record} />
    <PaperEditorFields kind={kind} record={record} form={form} readOnly={readOnly} busy={busy} save={save} />
    {record && !record.revision && <p role="alert">Versionsvertrag fehlt. Eine kompatible Serverversion ist zum Bearbeiten erforderlich.</p>}
    <PaperReceipt receipt={receipt} />
  </section>;
}
export function PaperLab({ readOnly = true }: Readonly<{ readOnly?: boolean }>) {
  const { confirm, confirmationDialog } = useConfirmationDialog();
  const [snapshot, setSnapshot] = useState<PaperSnapshot | null>(null); const [accountId, setAccountId] = useState(''); const [symbol, setSymbol] = useState('');
  const [error, setError] = useState(''); const [message, setMessage] = useState('');
  const [reload, setReload] = useState(0); const generation = useRef(0);
  const [editorStates, setEditorStates] = useState<Record<string, { dirty: boolean; busy: boolean }>>({});
  const onState = useCallback((kind: string, dirty: boolean, busy: boolean) => setEditorStates(previous => ({ ...previous, [kind]: { dirty, busy } })), []);
  const busy = Object.values(editorStates).some(item => item.busy);
  const read = useCallback(async (signal: AbortSignal) => { const sequence = generation.current; return { value: await jsonRequest('/api/trading', { signal }), sequence }; }, []);
  usePoll(read, result => { if (result.sequence === generation.current) { setSnapshot(result.value); setError(''); } }, reason => setError(reason.message), 5000, reload);
  const refresh = async () => { setReload(value => value + 1); };
  const accounts = (snapshot?.accounts ?? []).filter((account) => account.exchange === 'paper' && account.mode === 'paper');
  const account = accounts.find((item) => item.id === accountId);
  const markets = (snapshot?.activity?.paperMarkets ?? []).filter((item) => item.accountId === accountId);
  const record = markets.find((item) => item.symbol === symbol) ?? null;
  const balance = (snapshot?.activity?.paperAccounts ?? []).find((item) => item.accountId === accountId) ?? null;
  const accepted = (result: PaperResult | null | undefined, kind: 'market' | 'balance') => {
    generation.current++;
    setMessage('Paper-Änderung bestätigt. Simulierte Fills, Positionen und Schutz anhand der aktualisierten Belege prüfen.');
    if (!result) return;
    const market = result.market; const balance = result.balance;
    setSnapshot((current) => {
      if (!current) return current;
      return { ...current, activity: { ...current.activity,
        ...(market ? { paperMarkets: [...current.activity.paperMarkets.filter((item) => item.accountId !== result.accountId || item.symbol !== market.symbol), market] } : {}),
        ...(balance ? { paperAccounts: [...(current.activity.paperAccounts ?? []).filter((item) => item.accountId !== result.accountId), balance] } : {}),
      } };
    });
    if (kind === 'market' && result.market && !symbol) setSymbol(result.market.symbol);
  };
  // Browser navigation is guarded by each editor; selections also ask before unmounting either draft.
  const select = async (change: () => void, dirty: boolean) => { if (!dirty || await confirm({ title: 'Paper-Auswahl wechseln?', description: 'Ungespeicherte Paper-Eingaben verwerfen und die Auswahl wechseln?', confirmLabel: 'Eingaben verwerfen', destructive: true })) { change(); setMessage(''); } };
  const accountSection = (
    <section className="operations-card system-form"><label>Paper-Konto<select disabled={busy} value={accountId} onChange={event => { const id = event.target.value; select(() => { setAccountId(id); setSymbol(''); }, Object.values(editorStates).some(item => item.dirty)); }}><option value="">Konto wählen</option>{accounts.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>{!accounts.length && <p>Zuerst unter Trading → Konten ein Paper-Konto anlegen.</p>}</section>
  );
  const marketSection = (
    <section className="operations-card system-form"><label>Vorhandener Markt<select disabled={busy} value={symbol} onChange={event => { const value = event.target.value; select(() => setSymbol(value), editorStates.market?.dirty ?? false); }}><option value="">Neuer Markt</option>{markets.map((item) => <option key={item.symbol}>{item.symbol}</option>)}</select></label></section>
  );

  return <div className="operations-stack">{confirmationDialog}<h1>Paper-Labor · ausschließlich Simulation</h1><p>Paper-Kurse, Paper-Bestände und simulierte Ausführungen. Testnet- und Live-Konten sind hier nicht auswählbar.</p>
    {error && <p role="alert">{error} · Vorhandene Daten können veraltet sein.</p>}{message && <p><output>{message}</output></p>}
    {accountSection}
    {account && <>{marketSection}
      <PaperEditor key={`market:${accountId}:${symbol}`} kind="market" account={account} record={record} readOnly={readOnly} accepted={accepted} refresh={refresh} onState={onState} />
      <PaperEditor key={`balance:${accountId}`} kind="balance" account={account} record={balance} readOnly={readOnly} accepted={accepted} refresh={refresh} onState={onState} />
      <section className="operations-card"><EvidenceTable caption="Beobachtete Paper-Märkte" rows={markets} columns={[["symbol", "Symbol"], ["markPrice", "Markpreis"], ["priceTick", "Tick"], ["quantityStep", "Mengenschritt"], ["minimumQuantity", "Mindestmenge"], ["minimumNotional", "Mindestnotional"], ["maxLeverage", "Maximaler Hebel"], ["updatedAt", "Stand (Unix ms)"]]} /></section></>}
  </div>;
}

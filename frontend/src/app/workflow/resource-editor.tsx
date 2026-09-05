import {
  Children,
  isValidElement,
  useEffect,
  useMemo,
  useState,
  type ReactElement,
  type ReactNode,
} from "react";
import { AlertTriangle, Archive, Check, Plus, Trash2 } from "lucide-react";
import { jsonRequest } from "@/lib/api";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { NativeSelect } from "@/components/ui/native-select";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import {
  KIND_META,
  type SignalContractDefinition,
  type StrategyConfiguration,
  type TradingSnapshot,
  type WorkflowKind,
  type WorkflowResource,
} from "./types";

type ResourceEditorProps = Readonly<{
  open: boolean;
  kind: WorkflowKind;
  resource: WorkflowResource | null;
  trading: TradingSnapshot | null;
  parserSources?: BuilderParserSource[];
  onClose: () => void;
  onSave: (value: {
    name: string;
    description: string;
    configuration: Record<string, unknown>;
  }) => Promise<boolean>;
  onDeleteNode?: () => Promise<void>;
  onArchiveResource?: () => Promise<void>;
  onDeleteResource?: () => Promise<void>;
  onConfigureAccount?: (accountId: string, maximum: number) => Promise<void>;
}>;

export type BuilderParserSource = Readonly<{
  nodeId: string;
  resourceVersionId: string;
  name: string;
  templateName: string;
  connected: boolean;
}>;

function lines(value: unknown): string {
  return Array.isArray(value) ? value.join("\n") : "";
}

function list(value: string): string[] {
  return value
    .split(/\r?\n|,/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function numberValue(value: unknown, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function textValue(value: unknown, fallback = ""): string {
  if (typeof value === "string") return value;
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return fallback;
}

function applyParserDraft(
  configuration: Record<string, unknown>,
  templateContent: string,
): void {
  if (!templateContent.trim())
    throw new Error("Der Parser-Prompt darf nicht leer sein.");
  configuration.templateName = "inline";
  configuration.prompt = templateContent.trim();
  configuration.saveToFile = false;
}

function defaultStrategyConfiguration(
  trading: TradingSnapshot | null,
): StrategyConfiguration {
  const schemas = (trading?.signalSchemas || [])
    .filter((schema) => schema.enabled)
    .map((schema) => schema.id);
  return {
    schemaVersion: 4,
    allowedSignalSchemas: schemas,
    allowedSymbols: [],
    allowedSides: ["LONG", "SHORT"],
    entry: {
      orderType: "limit",
      rangePrice: "midpoint",
      postOnly: false,
      timeoutSeconds: 10,
    },
    sizing: {
      positionSizingMode: "risk_percent",
      riskPerTradePercent: "1",
      maxAdaptiveRiskPercent: "1",
      maxPositionNotional: "1000",
      defaultLeverage: 3,
      maxLeverage: 3,
    },
    exits: {
      targetAllocationMode: "manual",
      targetAllocationsPercent: ["50", "50"],
      stopLossMode: "configured",
      moveStopToBreakEvenAfterTarget: 1,
      trailingStopPercent: null,
      closeRemainderAtLastTarget: true,
    },
    safety: {
      maxDailyLossMode: "absolute",
      maxDailyLoss: "100",
      maxSlippagePercent: "0.5",
      entryOrderTtlSeconds: 900,
      requireProtectiveStop: true,
    },
  };
}

function defaultContractDefinition(): SignalContractDefinition {
  return {
    schemaVersion: 1,
    rootTag: "signal",
    actionPath: "action",
    pairPath: "pair",
    entry: {
      mode: "optional_range",
      marketValues: [],
      rangeValues: [],
      minimumPath: "entry_range.min",
      maximumPath: "entry_range.max",
    },
    targets: {
      containerPath: "targets",
      itemTag: "target",
      shape: "scalar",
      minimumPath: "min",
      maximumPath: "max",
      minimumItems: 1,
      maximumItems: 20,
      sequentialIds: true,
    },
    stopLossPath: "stoploss",
    leveragePath: "leverage",
    additionalFields: [],
    geometry: {
      stopOnLossSide: true,
      targetsOnProfitSide: true,
      orderedTargets: true,
      orderedRanges: true,
    },
    grounding: {
      action: true,
      pair: true,
      entry: true,
      targets: true,
      stopLoss: true,
      leverage: true,
      riskPercent: true,
      averagingPrice: true,
    },
  };
}

async function publishStrategyDraft(
  configuration: Record<string, unknown>,
  trading: TradingSnapshot | null,
  strategyDraft: StrategyConfiguration,
  metadata: { name: string; description: string },
): Promise<void> {
  const selected = trading?.strategies.find(
    (item) => item.id === configuration.strategyVersionId,
  );
  if (strategyDraft.allowedSignalSchemas.length === 0) {
    throw new Error(
      "Die Strategie benötigt mindestens ein aktives Signal-Schema. Erstelle zuerst einen Schema-Baustein.",
    );
  }
  const publishConfiguration: StrategyConfiguration = {
    ...strategyDraft,
    schemaVersion: 4,
    sizing: {
      ...strategyDraft.sizing,
      defaultLeverage:
        strategyDraft.sizing.defaultLeverage ?? strategyDraft.sizing.maxLeverage,
    },
  };
  const draft = await jsonRequest("/api/trading/strategies", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      ...(selected ? { strategyId: selected.strategyId } : {}),
      name: metadata.name,
      description: metadata.description,
      configuration: publishConfiguration,
    }),
  });
  const published = await jsonRequest("/api/trading/strategies/publish", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ id: draft.result.id }),
  });
  configuration.strategyVersionId = published.result.id;
}

async function publishContractDraft(
  configuration: Record<string, unknown>,
  trading: TradingSnapshot | null,
  contractDraft: SignalContractDefinition,
  contractId: string,
  metadata: { name: string; description: string },
): Promise<void> {
  const parent = trading?.signalContracts.find((contract) =>
    contract.versions.some(
      (version) => version.id === configuration.contractVersionId,
    ),
  );
  const source = parent?.versions.find(
    (version) => version.id === configuration.contractVersionId,
  );
  if (!parent || !source) {
    const normalizedId = contractId.trim();
    if (!normalizedId) throw new Error("Die Vertrags-ID darf nicht leer sein.");
    const created = await jsonRequest("/api/trading/signal-contracts", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        id: normalizedId,
        name: metadata.name,
        description: metadata.description,
        definition: contractDraft,
      }),
    });
    const versionId = created.result?.versions?.[0]?.id;
    if (!versionId)
      throw new Error("Der neue Signal-Vertrag enthält keine Entwurfsversion.");
    const published = await jsonRequest(
      "/api/trading/signal-contracts/publish",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ versionId }),
      },
    );
    configuration.contractVersionId = published.result.id;
    return;
  }
  const draft = await jsonRequest("/api/trading/signal-contracts/versions", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ contractId: parent.id, sourceVersionId: source.id }),
  });
  await jsonRequest("/api/trading/signal-contracts/update", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      contractId: parent.id,
      versionId: draft.result.id,
      name: metadata.name,
      description: metadata.description,
      definition: contractDraft,
    }),
  });
  const published = await jsonRequest("/api/trading/signal-contracts/publish", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ versionId: draft.result.id }),
  });
  configuration.contractVersionId = published.result.id;
}

async function createSchemaDraft(
  configuration: Record<string, unknown>,
  schemaDraft: SignalSchemaDraft,
): Promise<void> {
  const id = textValue(schemaDraft.id).trim();
  if (!id || id === schemaDraft.originalId) {
    throw new Error(
      "Änderungen an einem verwendeten Signal-Schema benötigen eine neue eindeutige Schema-ID.",
    );
  }
  const created = await jsonRequest("/api/trading/signal-schemas", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      id,
      name: schemaDraft.name,
      description: schemaDraft.description,
      definition: schemaDraft.definition,
      templateName: id,
      enabled: schemaDraft.enabled !== false,
    }),
  });
  configuration.schemaId = created.result.id;
}

type TradingSignalSchema = TradingSnapshot["signalSchemas"][number];

type SignalSchemaDraft = Readonly<{
  id: string;
  originalId: string;
  name: string;
  description: string;
  definition: SignalContractDefinition;
  enabled: boolean;
  copying: boolean;
}>;

function signalSchemaDraft(
  schema: TradingSignalSchema | undefined,
): SignalSchemaDraft {
  return schema
    ? {
        id: schema.id,
        originalId: schema.id,
        name: schema.name,
        description: schema.description,
        definition: structuredClone(
          schema.definition || schema.contractDefinition || defaultContractDefinition(),
        ),
        enabled: schema.enabled,
        copying: false,
      }
    : {
        id: "new-schema",
        originalId: "",
        name: "Neues Signal-Schema",
        description: "",
        definition: defaultContractDefinition(),
        enabled: true,
        copying: true,
      };
}

function uniqueSchemaCopyId(
  sourceId: string,
  schemas: TradingSignalSchema[],
): string {
  const used = new Set(schemas.map((schema) => schema.id));
  const base = `${sourceId}-copy`;
  if (!used.has(base)) return base;
  let suffix = 2;
  while (used.has(`${base}-${suffix}`)) suffix += 1;
  return `${base}-${suffix}`;
}

type ConfigurationDrafts = Readonly<{
  kind: WorkflowKind;
  configuration: Record<string, unknown>;
  templateContent: string;
  trading: TradingSnapshot | null;
  strategyDraft: StrategyConfiguration | null;
  strategyTouched: boolean;
  contractDraft: SignalContractDefinition | null;
  contractTouched: boolean;
  contractId: string;
  schemaDraft: SignalSchemaDraft | null;
  schemaTouched: boolean;
  resourceName: string;
  resourceDescription: string;
}>;

async function applyStrategyChanges(
  configuration: Record<string, unknown>,
  drafts: ConfigurationDrafts,
): Promise<void> {
  if (drafts.kind !== "strategy" || !drafts.strategyTouched) return;
  if (!drafts.strategyDraft)
    throw new Error("Die gewählte Strategieversion ist nicht verfügbar.");
  await publishStrategyDraft(
    configuration,
    drafts.trading,
    drafts.strategyDraft,
    { name: drafts.resourceName, description: drafts.resourceDescription },
  );
}

async function applyContractChanges(
  configuration: Record<string, unknown>,
  drafts: ConfigurationDrafts,
): Promise<void> {
  if (drafts.kind !== "contract" || !drafts.contractTouched) return;
  if (!drafts.contractDraft)
    throw new Error("Die gewählte Vertragsversion ist nicht verfügbar.");
  await publishContractDraft(
    configuration,
    drafts.trading,
    drafts.contractDraft,
    drafts.contractId,
    { name: drafts.resourceName, description: drafts.resourceDescription },
  );
}

async function prepareConfiguration(
  drafts: ConfigurationDrafts,
): Promise<Record<string, unknown>> {
  const configuration = structuredClone(drafts.configuration);
  const leverageSizing: Record<string, unknown> | StrategyConfiguration["sizing"] | null =
    drafts.kind === "strategy"
      ? drafts.strategyDraft?.sizing ?? null
      : drafts.kind === "sizing"
        ? configuration
        : null;
  if (leverageSizing) {
    const maximum = Number(leverageSizing.maxLeverage);
    const fallback = Number(leverageSizing.defaultLeverage ?? maximum);
    if (!Number.isSafeInteger(fallback) || fallback < 1 || fallback > 50) {
      throw new Error("Standard-Hebel muss eine ganze Zahl zwischen 1 und 50 sein.");
    }
    if (!Number.isSafeInteger(maximum) || maximum < 1 || maximum > 50) {
      throw new Error("Maximaler Hebel muss eine ganze Zahl zwischen 1 und 50 sein.");
    }
    if (fallback > maximum) {
      throw new Error("Standard-Hebel darf den maximalen Hebel nicht überschreiten.");
    }
    leverageSizing.defaultLeverage = fallback;
    leverageSizing.maxLeverage = maximum;
  }
  if (drafts.kind === "parser")
    applyParserDraft(configuration, drafts.templateContent);
  await applyStrategyChanges(configuration, drafts);
  await applyContractChanges(configuration, drafts);
  if (drafts.kind === "schema" && drafts.schemaTouched) {
    if (!drafts.schemaDraft)
      throw new Error("Das zu kopierende Signal-Schema ist nicht verfügbar.");
    await createSchemaDraft(configuration, drafts.schemaDraft);
  }
  return configuration;
}

export function defaultConfiguration(
  kind: WorkflowKind,
  trading: TradingSnapshot | null,
): Record<string, unknown> {
  const account = trading?.accounts[0];
  const defaults: Record<WorkflowKind, Record<string, unknown>> = {
    channel: { channelId: "" },
    content_filter: { allowedTypes: ["text"] },
    keyword_filter: { allowedKeywords: [], blockedKeywords: [] },
    regex: { patterns: [], mode: "all" },
    parser: { templateName: "inline", timeoutMs: 120_000, saveToFile: false },
    schema: { schemaId: "" },
    contract: { contractVersionId: "" },
    dedupe: { enabled: true, cooldownHours: 24 },
    strategy: { strategyVersionId: "" },
    sizing: {
      positionSizingMode: "equity_percent_margin",
      riskPerTradePercent: "5",
      maxAdaptiveRiskPercent: "10",
      maxPositionNotional: "1000000000",
      defaultLeverage: 50,
      maxLeverage: 50,
    },
    adaptive_risk: {
      enabled: true,
      mode: "automatic",
      tiers: [
        { riskPercent: "5" },
        { riskPercent: "7.5" },
        { riskPercent: "10" },
      ],
      startingTier: 0,
      lockedTier: null,
      lookbackWeeks: 1,
      minimumClosedTrades: 5,
      lossThresholdPercent: "2",
      profitThresholdPercent: "2",
      weakChannelAction: "reduce",
      weakWeeksBeforeBlock: 3,
      manuallyBlocked: false,
    },
    account: { accountId: account?.id || "" },
    output: { mode: "audit_only" },
  };
  return defaults[kind];
}

function Field(
  props: Readonly<{ label: string; hint?: string; children: ReactNode }>,
) {
  const controls = Children.map(props.children, (child) => {
    if (!isValidElement(child)) return child;
    const element = child as ReactElement<Record<string, unknown>>;
    if (element.type === "input") return <Input {...element.props} />;
    if (element.type === "textarea") return <Textarea {...element.props} />;
    if (element.type === "select")
      return <NativeSelect className="w-full" {...element.props} />;
    return child;
  });
  return (
    <Label className="builder-field">
      <span>{props.label}</span>
      {controls}
      {props.hint && <small>{props.hint}</small>}
    </Label>
  );
}

function Toggle({
  checked,
  onChange,
  label,
  disabled = false,
}: Readonly<{
  checked: boolean;
  onChange: (checked: boolean) => void;
  label: string;
  disabled?: boolean;
}>) {
  return (
    <Label className="builder-toggle" aria-disabled={disabled}>
      <Switch
        checked={checked}
        disabled={disabled}
        onCheckedChange={onChange}
      />
      {label}
    </Label>
  );
}

function StrategyForm({
  value,
  onChange,
}: Readonly<{
  value: StrategyConfiguration;
  onChange: (value: StrategyConfiguration) => void;
}>) {
  const section = <
    Name extends "entry" | "sizing" | "exits" | "safety",
  >(
    name: Name,
    changes: Partial<StrategyConfiguration[Name]>,
  ) =>
    onChange({
      ...value,
      [name]: { ...value[name], ...changes },
    });
  const setAccess = <Name extends "allowedSignalSchemas" | "allowedSymbols" | "allowedSides">(
    name: Name,
    next: StrategyConfiguration[Name],
  ) => onChange({ ...value, [name]: next });
  const toggleSide = (side: "LONG" | "SHORT", enabled: boolean) => {
    const next = enabled
      ? [...new Set([...value.allowedSides, side])]
      : value.allowedSides.filter((candidate) => candidate !== side);
    setAccess("allowedSides", next);
  };

  return (
    <div className="strategy-form">
      <section>
        <div className="strategy-section-heading">
          <strong>Freigaben</strong>
          <small>Welche Signale diese Strategie überhaupt annehmen darf.</small>
        </div>
        <div className="builder-field-grid three">
          <Field label="Erlaubte Signal-Schemas" hint="Eine Schema-ID je Zeile.">
            <textarea
              value={value.allowedSignalSchemas.join("\n")}
              onChange={(event) =>
                setAccess("allowedSignalSchemas", list(event.target.value))
              }
            />
          </Field>
          <Field label="Erlaubte Symbole" hint="Leer erlaubt alle Symbole.">
            <textarea
              value={value.allowedSymbols.join("\n")}
              onChange={(event) =>
                setAccess(
                  "allowedSymbols",
                  list(event.target.value).map((item) => item.toUpperCase()),
                )
              }
            />
          </Field>
          <div className="strategy-toggle-stack">
            <span>Erlaubte Richtungen</span>
            <Toggle
              checked={value.allowedSides.includes("LONG")}
              onChange={(enabled) => toggleSide("LONG", enabled)}
              label="LONG"
            />
            <Toggle
              checked={value.allowedSides.includes("SHORT")}
              onChange={(enabled) => toggleSide("SHORT", enabled)}
              label="SHORT"
            />
          </div>
        </div>
      </section>

      <section>
        <div className="strategy-section-heading">
          <strong>Entry</strong>
          <small>Orderart, Preiswahl und maximale Wartezeit.</small>
        </div>
        <div className="builder-field-grid three">
          <Field label="Orderart">
            <select
              value={value.entry.orderType}
              onChange={(event) =>
                section("entry", {
                  orderType: event.target.value as "market" | "limit",
                  postOnly:
                    event.target.value === "market"
                      ? false
                      : value.entry.postOnly,
                })
              }
            >
              <option value="limit">Limit</option>
              <option value="market">Market</option>
            </select>
          </Field>
          <Field
            label="Preis im Entry-Bereich"
            hint="Near liegt näher am aktuellen Kurs, far weiter entfernt."
          >
            <select
              value={value.entry.rangePrice}
              disabled={value.entry.orderType === "market"}
              onChange={(event) =>
                section("entry", {
                  rangePrice: event.target.value as "near" | "midpoint" | "far",
                })
              }
            >
              <option value="near">Near</option>
              <option value="midpoint">Mittelpunkt</option>
              <option value="far">Far</option>
            </select>
          </Field>
          <Field label="Order-Timeout (Sekunden)" hint="2 bis 30 Sekunden.">
            <input
              type="number"
              min={2}
              max={30}
              value={value.entry.timeoutSeconds}
              onChange={(event) =>
                section("entry", { timeoutSeconds: Number(event.target.value) })
              }
            />
          </Field>
          <Toggle
            checked={value.entry.postOnly}
            onChange={(postOnly) => section("entry", { postOnly })}
            disabled={value.entry.orderType === "market"}
            label="Post-only (nur bei Limit)"
          />
        </div>
      </section>

      <section>
        <div className="strategy-section-heading">
          <strong>Fallback-Positionsgröße</strong>
          <small>
            Ein nachgeschalteter Positionsgrößen-Baustein überschreibt diese
            Grundwerte für seinen konkreten Pfad.
          </small>
        </div>
        <div className="builder-field-grid three">
          <Field label="Größenmodus">
            <select
              value={value.sizing.positionSizingMode || "risk_percent"}
              onChange={(event) =>
                section("sizing", {
                  positionSizingMode: event.target.value as NonNullable<
                    StrategyConfiguration["sizing"]["positionSizingMode"]
                  >,
                })
              }
            >
              <option value="equity_percent_margin">
                Portfolioanteil als eingesetztes Kapital
              </option>
              <option value="equity_percent_notional">
                Portfolioanteil als Positionswert
              </option>
              <option value="risk_percent">Risiko bis Stop-Loss</option>
            </select>
          </Field>
          <Field label="Basis pro Trade (%)">
            <input
              type="number"
              min="0.01"
              max="10"
              step="0.01"
              value={value.sizing.riskPerTradePercent}
              onChange={(event) =>
                section("sizing", { riskPerTradePercent: event.target.value })
              }
            />
          </Field>
          <Field label="Max. adaptiv (%)">
            <input
              type="number"
              min="0.01"
              max="10"
              step="0.01"
              value={value.sizing.maxAdaptiveRiskPercent || ""}
              onChange={(event) =>
                section("sizing", {
                  maxAdaptiveRiskPercent: event.target.value,
                })
              }
            />
          </Field>
          <Field label="Notional-Obergrenze">
            <input
              value={value.sizing.maxPositionNotional}
              onChange={(event) =>
                section("sizing", { maxPositionNotional: event.target.value })
              }
            />
          </Field>
          <Field
            label="Standard-Hebel"
            hint="Wird verwendet, wenn das Signal keinen Hebel enthält."
          >
            <input
              type="number"
              min={1}
              max={50}
              value={value.sizing.defaultLeverage ?? value.sizing.maxLeverage}
              onChange={(event) =>
                section("sizing", { defaultLeverage: Number(event.target.value) })
              }
            />
          </Field>
          <Field
            label="Maximaler Hebel"
            hint="Begrenzt Signal-Leverage; das Exchange-Limit kann zusätzlich niedriger sein."
          >
            <input
              type="number"
              min={1}
              max={50}
              value={value.sizing.maxLeverage}
              onChange={(event) =>
                section("sizing", { maxLeverage: Number(event.target.value) })
              }
            />
          </Field>
        </div>
      </section>

      <section>
        <div className="strategy-section-heading">
          <strong>Take Profit & Stop</strong>
          <small>Verteilung der Targets und Verhalten des Schutz-Stops.</small>
        </div>
        <div className="builder-field-grid three">
          <Field label="Target-Verteilung">
            <select
              value={value.exits.targetAllocationMode}
              onChange={(event) =>
                section("exits", {
                  targetAllocationMode: event.target.value as
                    | "manual"
                    | "adaptive_halving",
                })
              }
            >
              <option value="manual">Manuelle Prozente</option>
              <option value="adaptive_halving">Jeweils halber Rest</option>
            </select>
          </Field>
          <Field
            label="Target-Anteile (%)"
            hint="Ein Wert je Zeile; zusammen exakt 100 %."
          >
            <textarea
              value={value.exits.targetAllocationsPercent.join("\n")}
              onChange={(event) =>
                section("exits", {
                  targetAllocationsPercent: list(event.target.value),
                })
              }
            />
          </Field>
          <Field label="Stop-Loss-Modus">
            <select
              value={value.exits.stopLossMode}
              onChange={(event) =>
                section("exits", {
                  stopLossMode: event.target.value as
                    | "configured"
                    | "adaptive_targets",
                })
              }
            >
              <option value="configured">Signal-SL + konfiguriertes Nachziehen</option>
              <option value="adaptive_targets">Adaptiv anhand erreichter Targets</option>
            </select>
          </Field>
          <Field
            label="Break-even nach Target"
            hint="Verwendet den tatsächlichen volumengewichteten Fill-Einstieg (ohne Gebühren). Leer lässt diese Regel aus."
          >
            <input
              type="number"
              min={1}
              max={value.exits.targetAllocationsPercent.length}
              value={value.exits.moveStopToBreakEvenAfterTarget ?? ""}
              onChange={(event) =>
                section("exits", {
                  moveStopToBreakEvenAfterTarget: event.target.value
                    ? Number(event.target.value)
                    : null,
                })
              }
            />
          </Field>
          <Field label="Trailing Stop (%)" hint="Leer deaktiviert zusätzliches Trailing.">
            <input
              type="number"
              min="0.01"
              max="20"
              step="0.01"
              value={value.exits.trailingStopPercent ?? ""}
              onChange={(event) =>
                section("exits", {
                  trailingStopPercent: event.target.value || null,
                })
              }
            />
          </Field>
          <div className="builder-locked-note">
            <Check size={16} /> Am letzten Target wird der komplette Rest
            geschlossen.
          </div>
        </div>
      </section>

      <section>
        <div className="strategy-section-heading">
          <strong>Sicherheitsgrenzen</strong>
          <small>
            Verlust-, Slippage- und Ablaufgrenzen. Die Positionsanzahl wird am
            Börsenkonto verwaltet.
          </small>
        </div>
        <div className="builder-field-grid three">
          <Field label="Daily-Loss-Modus">
            <select
              value={value.safety.maxDailyLossMode || "absolute"}
              onChange={(event) =>
                section("safety", {
                  maxDailyLossMode: event.target.value as
                    | "absolute"
                    | "equity_percent",
                })
              }
            >
              <option value="equity_percent">Prozent des Portfolios</option>
              <option value="absolute">Absoluter Betrag</option>
            </select>
          </Field>
          <Field
            label={
              value.safety.maxDailyLossMode === "equity_percent"
                ? "Max. Daily Loss (%)"
                : "Max. Daily Loss (Quote-Währung)"
            }
          >
            <input
              type="number"
              min="0.01"
              max={
                value.safety.maxDailyLossMode === "equity_percent"
                  ? "100"
                  : undefined
              }
              step="0.01"
              value={value.safety.maxDailyLoss}
              onChange={(event) =>
                section("safety", { maxDailyLoss: event.target.value })
              }
            />
          </Field>
          <Field label="Max. Slippage (%)">
            <input
              type="number"
              min="0.01"
              max="5"
              step="0.01"
              value={value.safety.maxSlippagePercent}
              onChange={(event) =>
                section("safety", { maxSlippagePercent: event.target.value })
              }
            />
          </Field>
          <Field label="Entry-Gültigkeit (Sekunden)" hint="10 bis 86.400.">
            <input
              type="number"
              min={10}
              max={86400}
              value={value.safety.entryOrderTtlSeconds}
              onChange={(event) =>
                section("safety", {
                  entryOrderTtlSeconds: Number(event.target.value),
                })
              }
            />
          </Field>
          <div className="builder-locked-note">
            <Check size={16} /> Ein Schutz-Stop ist immer verpflichtend.
          </div>
        </div>
      </section>
    </div>
  );
}

function ContractForm({
  value,
  onChange,
  mode = "contract",
}: Readonly<{
  value: SignalContractDefinition;
  onChange: (value: SignalContractDefinition) => void;
  mode?: "schema" | "contract";
}>) {
  const section = <
    Name extends "entry" | "targets" | "geometry" | "grounding",
  >(
    name: Name,
    changes: Partial<SignalContractDefinition[Name]>,
  ) => onChange({ ...value, [name]: { ...value[name], ...changes } });
  const optionalPath = (
    name: "leveragePath" | "riskPercentPath" | "averagingPricePath",
    next: string,
  ) => {
    const updated = { ...value };
    if (next.trim()) updated[name] = next;
    else delete updated[name];
    onChange(updated);
  };

  return (
    <div className="strategy-form contract-form">
      <section>
        <div className="strategy-section-heading">
          <strong>{mode === "schema" ? "Normalisierte Signal-Felder" : "Signal-Felder"}</strong>
          <small>
            {mode === "schema"
              ? "Diese Pfade und Typen bilden die Ausgabe des verbundenen Parser-Bausteins. Das Root-Element bleibt aus Sicherheitsgründen „signal“."
              : "XML-Pfade für Richtung, Paar, Stop sowie optionale Angaben. Das Root-Element bleibt aus Sicherheitsgründen „signal“."}
          </small>
        </div>
        <div className="builder-field-grid three">
          <Field label="Richtungspfad">
            <input
              value={value.actionPath}
              onChange={(event) =>
                onChange({ ...value, actionPath: event.target.value })
              }
            />
          </Field>
          <Field label="Paarpfad">
            <input
              value={value.pairPath}
              onChange={(event) =>
                onChange({ ...value, pairPath: event.target.value })
              }
            />
          </Field>
          <Field label="Stop-Loss-Pfad">
            <input
              value={value.stopLossPath}
              onChange={(event) =>
                onChange({ ...value, stopLossPath: event.target.value })
              }
            />
          </Field>
          <Field label="Leverage-Pfad" hint="Optional.">
            <input
              value={value.leveragePath || ""}
              onChange={(event) =>
                optionalPath("leveragePath", event.target.value)
              }
            />
          </Field>
          <Field label="Risiko-Pfad" hint="Optional.">
            <input
              value={value.riskPercentPath || ""}
              onChange={(event) =>
                optionalPath("riskPercentPath", event.target.value)
              }
            />
          </Field>
          <Field label="Averaging-Pfad" hint="Optional.">
            <input
              value={value.averagingPricePath || ""}
              onChange={(event) =>
                optionalPath("averagingPricePath", event.target.value)
              }
            />
          </Field>
        </div>
      </section>

      <section>
        <div className="strategy-section-heading">
          <strong>{mode === "schema" ? "Entry-Struktur" : "Entry-Vertrag"}</strong>
          <small>{mode === "schema" ? "Wie der Parser Market- und Range-Entries normalisiert." : "Welche Entry-Formen und XML-Pfade zulässig sind."}</small>
        </div>
        <div className="builder-field-grid three">
          <Field label="Entry-Modus">
            <select
              value={value.entry.mode}
              onChange={(event) =>
                section("entry", {
                  mode: event.target.value as SignalContractDefinition["entry"]["mode"],
                })
              }
            >
              <option value="optional_range">Market oder optionaler Bereich</option>
              <option value="required_range">Bereich ist Pflicht</option>
              <option value="typed">Explizit typisiert</option>
            </select>
          </Field>
          <Field label="Entry-Typpfad" hint="Nur für typisierte Entries.">
            <input
              value={value.entry.typePath || ""}
              onChange={(event) =>
                section("entry", {
                  typePath: event.target.value || undefined,
                })
              }
            />
          </Field>
          <Field label="Minimum-Pfad">
            <input
              value={value.entry.minimumPath}
              onChange={(event) =>
                section("entry", { minimumPath: event.target.value })
              }
            />
          </Field>
          <Field label="Maximum-Pfad">
            <input
              value={value.entry.maximumPath}
              onChange={(event) =>
                section("entry", { maximumPath: event.target.value })
              }
            />
          </Field>
          <Field label="Market-Werte" hint="Ein erlaubter Wert je Zeile.">
            <textarea
              value={value.entry.marketValues.join("\n")}
              onChange={(event) =>
                section("entry", { marketValues: list(event.target.value) })
              }
            />
          </Field>
          <Field label="Range-Werte" hint="Ein erlaubter Wert je Zeile.">
            <textarea
              value={value.entry.rangeValues.join("\n")}
              onChange={(event) =>
                section("entry", { rangeValues: list(event.target.value) })
              }
            />
          </Field>
        </div>
      </section>

      <section>
        <div className="strategy-section-heading">
          <strong>{mode === "schema" ? "Target-Struktur" : "Target-Vertrag"}</strong>
          <small>{mode === "schema" ? "Wie Take-Profits in der normalisierten Parserausgabe aufgebaut sind." : "Form, Anzahl und Reihenfolge der Take-Profits."}</small>
        </div>
        <div className="builder-field-grid three">
          <Field label="Container-Pfad">
            <input
              value={value.targets.containerPath}
              onChange={(event) =>
                section("targets", { containerPath: event.target.value })
              }
            />
          </Field>
          <Field label="Element-Tag">
            <input
              value={value.targets.itemTag}
              onChange={(event) =>
                section("targets", { itemTag: event.target.value })
              }
            />
          </Field>
          <Field label="Target-Form">
            <select
              value={value.targets.shape}
              onChange={(event) =>
                section("targets", {
                  shape: event.target.value as "scalar" | "range",
                })
              }
            >
              <option value="scalar">Einzelpreis</option>
              <option value="range">Preisbereich</option>
            </select>
          </Field>
          <Field label="Minimum-Pfad">
            <input
              value={value.targets.minimumPath}
              onChange={(event) =>
                section("targets", { minimumPath: event.target.value })
              }
            />
          </Field>
          <Field label="Maximum-Pfad">
            <input
              value={value.targets.maximumPath}
              onChange={(event) =>
                section("targets", { maximumPath: event.target.value })
              }
            />
          </Field>
          <Field label="Mindestens Targets">
            <input
              type="number"
              min={1}
              max={20}
              value={value.targets.minimumItems}
              onChange={(event) =>
                section("targets", { minimumItems: Number(event.target.value) })
              }
            />
          </Field>
          <Field label="Maximal Targets">
            <input
              type="number"
              min={1}
              max={20}
              value={value.targets.maximumItems}
              onChange={(event) =>
                section("targets", { maximumItems: Number(event.target.value) })
              }
            />
          </Field>
          <Toggle
            checked={value.targets.sequentialIds}
            onChange={(sequentialIds) =>
              section("targets", { sequentialIds })
            }
            label="Fortlaufende Target-IDs verlangen"
          />
        </div>
      </section>

      <section>
        <div className="strategy-section-heading">
          <strong>Geometrie & Grounding</strong>
          <small>
            Plausibilitätsregeln sowie Felder, die ausdrücklich im Quelltext
            belegt sein müssen.
          </small>
        </div>
        <div className="contract-toggle-grid">
          <Toggle
            checked={value.geometry.stopOnLossSide}
            onChange={(stopOnLossSide) =>
              section("geometry", { stopOnLossSide })
            }
            label="Stop liegt auf Verlustseite"
          />
          <Toggle
            checked={value.geometry.targetsOnProfitSide}
            onChange={(targetsOnProfitSide) =>
              section("geometry", { targetsOnProfitSide })
            }
            label="Targets liegen auf Gewinnseite"
          />
          <Toggle
            checked={value.geometry.orderedTargets}
            onChange={(orderedTargets) =>
              section("geometry", { orderedTargets })
            }
            label="Targets müssen geordnet sein"
          />
          <Toggle
            checked={value.geometry.orderedRanges}
            onChange={(orderedRanges) =>
              section("geometry", { orderedRanges })
            }
            label="Bereiche müssen geordnet sein"
          />
          {(
            [
              ["action", "Richtung muss belegt sein"],
              ["pair", "Paar muss belegt sein"],
              ["entry", "Entry muss belegt sein"],
              ["targets", "Targets müssen belegt sein"],
              ["stopLoss", "Stop muss belegt sein"],
              ["leverage", "Leverage muss belegt sein"],
              ["riskPercent", "Risiko muss belegt sein"],
              ["averagingPrice", "Averaging muss belegt sein"],
            ] as const
          ).map(([name, label]) => (
            <Toggle
              key={name}
              checked={value.grounding[name]}
              onChange={(enabled) =>
                section("grounding", { [name]: enabled })
              }
              label={label}
            />
          ))}
        </div>
      </section>

      <section>
        <div className="strategy-section-heading contract-additional-heading">
          <span>
            <strong>Zusätzliche Felder</strong>
            <small>Optionale, typisierte Erweiterungen des Signalvertrags.</small>
          </span>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() =>
              onChange({
                ...value,
                additionalFields: [
                  ...value.additionalFields,
                  {
                    path: "",
                    type: "text",
                    required: false,
                    allowedValues: [],
                  },
                ],
              })
            }
          >
            <Plus data-icon="inline-start" /> Feld hinzufügen
          </Button>
        </div>
        {value.additionalFields.length === 0 ? (
          <p className="builder-info">Keine zusätzlichen Felder definiert.</p>
        ) : (
          <div className="contract-additional-list">
            {value.additionalFields.map((field, index) => {
              const update = (changes: Partial<typeof field>) =>
                onChange({
                  ...value,
                  additionalFields: value.additionalFields.map((candidate, itemIndex) =>
                    itemIndex === index ? { ...candidate, ...changes } : candidate,
                  ),
                });
              return (
                <div className="contract-additional-field" key={`${index}-${field.path}`}>
                  <div className="builder-field-grid three">
                    <Field label="Pfad">
                      <input
                        value={field.path}
                        onChange={(event) => update({ path: event.target.value })}
                      />
                    </Field>
                    <Field label="Typ">
                      <select
                        value={field.type}
                        onChange={(event) =>
                          update({
                            type: event.target.value as typeof field.type,
                          })
                        }
                      >
                        <option value="text">Text</option>
                        <option value="decimal">Dezimalzahl</option>
                        <option value="integer">Ganzzahl</option>
                        <option value="boolean">Boolean</option>
                      </select>
                    </Field>
                    <Toggle
                      checked={field.required}
                      onChange={(required) => update({ required })}
                      label="Pflichtfeld"
                    />
                    <Field label="Erlaubte Werte" hint="Optional, je Zeile ein Wert.">
                      <textarea
                        value={field.allowedValues.join("\n")}
                        onChange={(event) =>
                          update({ allowedValues: list(event.target.value) })
                        }
                      />
                    </Field>
                    <Field label="Minimum">
                      <input
                        value={field.minimum || ""}
                        onChange={(event) =>
                          update({ minimum: event.target.value || undefined })
                        }
                      />
                    </Field>
                    <Field label="Maximum">
                      <input
                        value={field.maximum || ""}
                        onChange={(event) =>
                          update({ maximum: event.target.value || undefined })
                        }
                      />
                    </Field>
                    <Field label="Max. Textlänge">
                      <input
                        type="number"
                        min={1}
                        value={field.maximumLength || ""}
                        onChange={(event) =>
                          update({
                            maximumLength: event.target.value
                              ? Number(event.target.value)
                              : undefined,
                          })
                        }
                      />
                    </Field>
                    <Field label="Muster (Regex)">
                      <input
                        value={field.pattern || ""}
                        onChange={(event) =>
                          update({ pattern: event.target.value || undefined })
                        }
                      />
                    </Field>
                  </div>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    onClick={() =>
                      onChange({
                        ...value,
                        additionalFields: value.additionalFields.filter(
                          (_, itemIndex) => itemIndex !== index,
                        ),
                      })
                    }
                  >
                    <Trash2 data-icon="inline-start" /> Feld entfernen
                  </Button>
                </div>
              );
            })}
          </div>
        )}
      </section>
    </div>
  );
}

function SignalSchemaResourceFields({
  schemaDraft,
  parserSources,
  onChange,
}: Readonly<{
  schemaDraft: SignalSchemaDraft | null;
  parserSources: BuilderParserSource[];
  onChange: (changes: Partial<SignalSchemaDraft>) => void;
}>) {
  if (!schemaDraft) return null;
  const copiedSchema = Boolean(schemaDraft.originalId && schemaDraft.copying);
  const schemaIdLabel = copiedSchema ? "Neue Schema-ID" : "Schema-ID";

  return (
    <div className="schema-copy-editor">
      <div className="strategy-section-heading">
        <strong>
          {schemaDraft.originalId
            ? "Signal-Schema bearbeiten"
            : "Neues Signal-Schema"}
        </strong>
        <small>
          {schemaDraft.originalId
            ? "Eine Änderung erzeugt automatisch eine neue unveränderliche Schema-ID."
            : "Baue hier die normalisierte Ausgabestruktur des Signals. Der konkrete Parser kommt aus den Verbindungen im Builder."}
        </small>
      </div>
      <div className="builder-field-grid three">
        <Field
          label={schemaIdLabel}
          hint="Muss eindeutig sein und mit einem Kleinbuchstaben beginnen."
        >
          <input
            aria-label={schemaIdLabel}
            value={schemaDraft.id}
            onChange={(event) => onChange({ id: event.target.value })}
          />
        </Field>
        <Field label="Schema-Name">
          <input
            aria-label="Schema-Name"
            value={schemaDraft.name}
            onChange={(event) => onChange({ name: event.target.value })}
          />
        </Field>
        <Field label="Beschreibung">
          <input
            value={schemaDraft.description}
            onChange={(event) => onChange({ description: event.target.value })}
          />
        </Field>
        <Toggle
          checked={schemaDraft.enabled}
          onChange={(enabled) => onChange({ enabled })}
          label="Schema aktiv"
        />
      </div>
      <section
        className="schema-parser-sources"
        aria-label="Parserquelle aus Builder"
      >
        <div className="strategy-section-heading">
          <strong>Parserquelle aus dem Builder</strong>
          <small>
            Das Parser-Schema wird nicht mehr aus fest eingebauten Profilen
            gewählt, sondern über die Verbindungen im Builder bestimmt.
          </small>
        </div>
        {parserSources.length > 0 ? (
          <div className="schema-parser-source-list">
            {parserSources.map((source) => (
              <div className="builder-locked-note" key={source.nodeId}>
                <Check size={16} />
                <span>
                  <strong>{source.name}</strong>
                  {source.connected
                    ? " · mit diesem Schema verbunden"
                    : " · im Builder verfügbar; nach dem Verbinden aktiv"}
                </span>
              </div>
            ))}
          </div>
        ) : (
          <Alert>
            <AlertTriangle />
            <AlertDescription>
              Im Builder ist noch kein KI-Parser vorhanden. Das Schema kann
              gespeichert werden, bleibt aber ohne verbundenen Parser inert.
            </AlertDescription>
          </Alert>
        )}
      </section>
      <ContractForm
        mode="schema"
        value={schemaDraft.definition}
        onChange={(definition) => onChange({ definition })}
      />
    </div>
  );
}

export function ResourceEditor({
  open,
  kind,
  resource,
  trading,
  parserSources = [],
  onClose,
  onSave,
  onDeleteNode,
  onArchiveResource,
  onDeleteResource,
  onConfigureAccount,
}: ResourceEditorProps) {
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [configuration, setConfiguration] = useState<Record<string, unknown>>(
    {},
  );
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [templateContent, setTemplateContent] = useState("");
  const [strategyDraft, setStrategyDraft] =
    useState<StrategyConfiguration | null>(null);
  const [strategyTouched, setStrategyTouched] = useState(false);
  const [contractDraft, setContractDraft] =
    useState<SignalContractDefinition | null>(null);
  const [contractTouched, setContractTouched] = useState(false);
  const [contractId, setContractId] = useState("new-contract");
  const [schemaDraft, setSchemaDraft] = useState<SignalSchemaDraft | null>(null);
  const [archiveConfirmation, setArchiveConfirmation] = useState(false);
  const [deleteConfirmation, setDeleteConfirmation] = useState(false);
  const meta = KIND_META[kind];

  useEffect(() => {
    if (!open) return;
    setName(resource?.name || `Neuer Baustein · ${meta.short}`);
    setDescription(resource?.description || "");
    setConfiguration(
      structuredClone(
        resource?.configuration || defaultConfiguration(kind, trading),
      ),
    );
    const nextConfiguration =
      resource?.configuration || defaultConfiguration(kind, trading);
    if (kind === "strategy") {
      const selected = trading?.strategies.find(
        (item) => item.id === nextConfiguration.strategyVersionId,
      );
      setStrategyDraft(
        selected
          ? structuredClone(selected.configuration)
          : defaultStrategyConfiguration(trading),
      );
      setStrategyTouched(!selected);
    } else if (kind === "contract") {
      const parent = trading?.signalContracts.find((contract) =>
        contract.versions.some(
          (version) => version.id === nextConfiguration.contractVersionId,
        ),
      );
      const selected = parent?.versions.find(
        (item) => item.id === nextConfiguration.contractVersionId,
      );
      setContractDraft(
        selected
          ? structuredClone(selected.definition)
          : defaultContractDefinition(),
      );
      setContractId(parent?.id || "new-contract");
      setContractTouched(!selected);
    }
    if (kind !== "strategy") setStrategyDraft(null);
    if (kind !== "contract") setContractDraft(null);
    if (kind !== "strategy") setStrategyTouched(false);
    if (kind !== "contract") {
      setContractTouched(false);
      setContractId("new-contract");
    }
    if (kind === "schema") {
      const selected = trading?.signalSchemas.find(
        (item) => item.id === nextConfiguration.schemaId,
      );
      setSchemaDraft(signalSchemaDraft(selected));
    } else setSchemaDraft(null);
    setTemplateContent(
      kind === "parser" && typeof nextConfiguration.prompt === "string"
        ? nextConfiguration.prompt
        : "",
    );
    setArchiveConfirmation(false);
    setDeleteConfirmation(false);
    setError("");
  }, [kind, meta.short, open, resource, trading]);

  const selectedAccount = useMemo(
    () =>
      trading?.accounts.find(
        (account) => account.id === configuration.accountId,
      ),
    [configuration.accountId, trading],
  );
  const [accountLimit, setAccountLimit] = useState(20);
  useEffect(
    () => setAccountLimit(selectedAccount?.maxConcurrentPositions ?? 20),
    [selectedAccount],
  );

  if (!open) return null;
  const set = (key: string, value: unknown) =>
    setConfiguration((previous) => ({ ...previous, [key]: value }));

  const submit = async () => {
    setSaving(true);
    setError("");
    try {
      const nextConfiguration = await prepareConfiguration({
        kind,
        configuration,
        templateContent,
        trading,
        strategyDraft,
        strategyTouched,
        contractDraft,
        contractTouched,
        contractId,
        schemaDraft,
        schemaTouched: schemaDraft?.copying === true,
        resourceName: name,
        resourceDescription: description,
      });
      const activated = await onSave({
        name,
        description,
        configuration: nextConfiguration,
      });
      if (!activated) return;
      if (kind === "account" && selectedAccount && onConfigureAccount) {
        await onConfigureAccount(selectedAccount.id, accountLimit);
      }
      onClose();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setSaving(false);
    }
  };

  const archiveResource = async () => {
    if (!onArchiveResource) return;
    setSaving(true);
    setError("");
    try {
      await onArchiveResource();
      onClose();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setSaving(false);
      setArchiveConfirmation(false);
    }
  };

  const deleteResource = async () => {
    if (!onDeleteResource) return;
    setSaving(true);
    setError("");
    try {
      await onDeleteResource();
      onClose();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setSaving(false);
      setDeleteConfirmation(false);
    }
  };

  const updateSchemaDraft = (changes: Partial<SignalSchemaDraft>) => {
    if (!schemaDraft) return;
    const copying = schemaDraft.copying || Boolean(schemaDraft.originalId);
    const id =
      !schemaDraft.copying && schemaDraft.originalId
        ? uniqueSchemaCopyId(
            schemaDraft.originalId,
            trading?.signalSchemas || [],
          )
        : schemaDraft.id;
    setSchemaDraft({
      ...schemaDraft,
      ...changes,
      id: changes.id ?? id,
      copying,
    });
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(nextOpen) => {
        if (!nextOpen) onClose();
      }}
    >
      <DialogContent
        className="builder-modal sm:max-w-4xl"
        closeLabel="Baustein-Editor schließen"
      >
        <DialogHeader>
          <Badge variant="secondary" style={{ color: meta.color }}>
            {meta.label}
          </Badge>
          <DialogTitle id="resource-editor-title">
            {resource ? "Baustein bearbeiten" : "Baustein erstellen"}
          </DialogTitle>
          <DialogDescription>
            Änderungen werden als unveränderliche Version gespeichert und
            anschließend atomar aktiviert.
          </DialogDescription>
        </DialogHeader>
        <div className="builder-modal-content">
          {error && (
            <Alert variant="destructive">
              <AlertTriangle />
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          )}
          <div className="builder-field-grid">
            <Field label="Name">
              <input
                value={name}
                maxLength={80}
                onChange={(event) => setName(event.target.value)}
              />
            </Field>
            <Field label="Beschreibung">
              <input
                value={description}
                maxLength={500}
                onChange={(event) => setDescription(event.target.value)}
              />
            </Field>
          </div>

          {kind === "channel" && (
            <Field
              label="Telegram-Kanal-ID"
              hint="Numerische Chat-ID, zum Beispiel -1002417439383."
            >
              <input
                value={textValue(configuration.channelId)}
                onChange={(event) => set("channelId", event.target.value)}
              />
            </Field>
          )}
          {kind === "content_filter" && (
            <Field
              label="Erlaubte Inhaltstypen"
              hint="Je Zeile ein Typ: text, photo, video, document …"
            >
              <textarea
                value={lines(configuration.allowedTypes)}
                onChange={(event) =>
                  set("allowedTypes", list(event.target.value))
                }
              />
            </Field>
          )}
          {kind === "keyword_filter" && (
            <div className="builder-field-grid">
              <Field
                label="Erlaubte Schlüsselwörter"
                hint="Leer bedeutet: keine Positivliste."
              >
                <textarea
                  value={lines(configuration.allowedKeywords)}
                  onChange={(event) =>
                    set("allowedKeywords", list(event.target.value))
                  }
                />
              </Field>
              <Field label="Blockierte Schlüsselwörter">
                <textarea
                  value={lines(configuration.blockedKeywords)}
                  onChange={(event) =>
                    set("blockedKeywords", list(event.target.value))
                  }
                />
              </Field>
            </div>
          )}
          {kind === "regex" && (
            <>
              <Field
                label="Regex-Muster"
                hint="Je Zeile ein Muster. Alle Muster laufen mit Zeitlimit und ReDoS-Prüfung."
              >
                <textarea
                  className="code-input"
                  value={lines(configuration.patterns)}
                  onChange={(event) =>
                    set("patterns", list(event.target.value))
                  }
                />
              </Field>
              <Field label="Verknüpfung">
                <select
                  value={textValue(configuration.mode, "all")}
                  onChange={(event) => set("mode", event.target.value)}
                >
                  <option value="all">Alle Muster müssen passen</option>
                  <option value="any">Mindestens ein Muster muss passen</option>
                </select>
              </Field>
            </>
          )}
          {kind === "parser" && (
            <>
              <div className="builder-field-grid three">
                <Field label="Zeitlimit in ms" hint="2.000 bis 120.000">
                  <input
                    type="number"
                    min={2000}
                    max={120000}
                    value={numberValue(configuration.timeoutMs, 120000)}
                    onChange={(event) =>
                      set("timeoutMs", Number(event.target.value))
                    }
                  />
                </Field>
                <Field label="Primärmodell">
                  <input
                    value={textValue(configuration.primaryModel)}
                    placeholder="Globales Modell verwenden"
                    onChange={(event) =>
                      set("primaryModel", event.target.value || undefined)
                    }
                  />
                </Field>
                <Field label="Fallback-Modell">
                  <input
                    value={textValue(configuration.fallbackModel)}
                    placeholder="Globales Modell verwenden"
                    onChange={(event) =>
                      set("fallbackModel", event.target.value || undefined)
                    }
                  />
                </Field>
                <div className="builder-locked-note">
                  <Check size={16} /> Signale werden ausschließlich in der
                  Datenbank gespeichert – niemals als Datei.
                </div>
              </div>
              <Field
                label="Parser-Prompt"
                hint="Diese Vorlage wird zusammen mit dem Parser-Baustein gespeichert. Serverseitige Schutzregeln bleiben zusätzlich aktiv."
              >
                <textarea
                  className="code-input prompt-input"
                  value={templateContent}
                  onChange={(event) => setTemplateContent(event.target.value)}
                />
              </Field>
            </>
          )}
          {kind === "schema" && (
            <SignalSchemaResourceFields
              schemaDraft={schemaDraft}
              parserSources={parserSources}
              onChange={updateSchemaDraft}
            />
          )}
          {kind === "contract" && (
            <>
              <Field
                label="Vertrags-ID"
                hint={
                  configuration.contractVersionId
                    ? "Die logische ID eines veröffentlichten Vertrags bleibt unveränderlich."
                    : "Kleinbuchstaben, Zahlen, Unterstrich oder Bindestrich."
                }
              >
                <input
                  aria-label="Vertrags-ID"
                  value={contractId}
                  disabled={Boolean(configuration.contractVersionId)}
                  onChange={(event) => setContractId(event.target.value)}
                />
              </Field>
              {contractDraft ? (
                <ContractForm
                  value={contractDraft}
                  onChange={(next) => {
                    setContractDraft(next);
                    setContractTouched(true);
                  }}
                />
              ) : (
                <Alert variant="destructive">
                  <AlertTriangle />
                  <AlertDescription>
                    Die gewählte Vertragsversion ist nicht verfügbar.
                  </AlertDescription>
                </Alert>
              )}
            </>
          )}
          {kind === "dedupe" && (
            <div className="builder-field-grid">
              <Toggle
                checked={configuration.enabled !== false}
                onChange={(value) => set("enabled", value)}
                label="Duplikatschutz aktiv"
              />
              <Field label="Cooldown in Stunden">
                <input
                  type="number"
                  min={0}
                  max={8760}
                  value={numberValue(configuration.cooldownHours, 24)}
                  onChange={(event) =>
                    set("cooldownHours", Number(event.target.value))
                  }
                />
              </Field>
            </div>
          )}
          {kind === "strategy" && (
            <>
              {strategyDraft ? (
                <>
                  {strategyDraft.allowedSignalSchemas.length === 0 && (
                    <Alert variant="destructive">
                      <AlertTriangle />
                      <AlertDescription>
                        Erstelle zuerst mindestens einen aktiven
                        Signal-Schema-Baustein.
                      </AlertDescription>
                    </Alert>
                  )}
                  <StrategyForm
                    value={strategyDraft}
                    onChange={(next) => {
                      setStrategyDraft(next);
                      setStrategyTouched(true);
                    }}
                  />
                </>
              ) : (
                <Alert variant="destructive">
                  <AlertTriangle />
                  <AlertDescription>
                    Die gewählte Strategieversion ist nicht verfügbar.
                  </AlertDescription>
                </Alert>
              )}
            </>
          )}
          {kind === "sizing" && (
            <div className="builder-field-grid three">
              <Field label="Größenmodus">
                <select
                  value={String(
                    configuration.positionSizingMode || "equity_percent_margin",
                  )}
                  onChange={(event) =>
                    set("positionSizingMode", event.target.value)
                  }
                >
                  <option value="equity_percent_margin">
                    Portfolioanteil als eingesetztes Kapital
                  </option>
                  <option value="equity_percent_notional">
                    Portfolioanteil als Positionswert
                  </option>
                  <option value="risk_percent">Risiko bis Stop-Loss</option>
                </select>
              </Field>
              <Field label="Basis pro Trade (%)">
                <input
                  type="number"
                  min="0.01"
                  max="10"
                  step="0.01"
                  value={textValue(configuration.riskPerTradePercent, "5")}
                  onChange={(event) =>
                    set("riskPerTradePercent", event.target.value)
                  }
                />
              </Field>
              <Field label="Max. adaptiv (%)">
                <input
                  type="number"
                  min="0.01"
                  max="10"
                  step="0.01"
                  value={textValue(configuration.maxAdaptiveRiskPercent, "10")}
                  onChange={(event) =>
                    set("maxAdaptiveRiskPercent", event.target.value)
                  }
                />
              </Field>
              <Field
                label="Standard-Hebel"
                hint="Wird verwendet, wenn das Signal keinen Hebel enthält."
              >
                <input
                  type="number"
                  min={1}
                  max={50}
                  value={numberValue(
                    configuration.defaultLeverage,
                    numberValue(configuration.maxLeverage, 50),
                  )}
                  onChange={(event) =>
                    set("defaultLeverage", Number(event.target.value))
                  }
                />
              </Field>
              <Field
                label="Maximaler Hebel"
                hint="Begrenzt Signal-Leverage; das Exchange-Limit kann zusätzlich niedriger sein."
              >
                <input
                  type="number"
                  min={1}
                  max={50}
                  value={numberValue(configuration.maxLeverage, 50)}
                  onChange={(event) =>
                    set("maxLeverage", Number(event.target.value))
                  }
                />
              </Field>
              <Field label="Notional-Obergrenze">
                <input
                  value={String(
                    configuration.maxPositionNotional || "1000000000",
                  )}
                  onChange={(event) =>
                    set("maxPositionNotional", event.target.value)
                  }
                />
              </Field>
            </div>
          )}
          {kind === "adaptive_risk" && (
            <>
              <div className="builder-field-grid three">
                <Toggle
                  checked={configuration.enabled !== false}
                  onChange={(value) => set("enabled", value)}
                  label="Adaptives Risiko aktiv"
                />
                <Field label="Modus">
                  <select
                    value={textValue(configuration.mode, "automatic")}
                    onChange={(event) => set("mode", event.target.value)}
                  >
                    <option value="automatic">Automatisch anwenden</option>
                    <option value="shadow">Nur Empfehlung</option>
                    <option value="fixed">Starr auf Basiswert</option>
                  </select>
                </Field>
                <Field
                  label="Risikostufen (%)"
                  hint="Aufsteigend, je Zeile eine Stufe."
                >
                  <textarea
                    value={
                      Array.isArray(configuration.tiers)
                        ? configuration.tiers
                            .map((tier: any) => tier.riskPercent)
                            .join("\n")
                        : ""
                    }
                    onChange={(event) =>
                      set(
                        "tiers",
                        list(event.target.value).map((riskPercent) => ({
                          riskPercent,
                        })),
                      )
                    }
                  />
                </Field>
                <Field label="Startstufe (0-basiert)">
                  <input
                    type="number"
                    min={0}
                    max={19}
                    value={numberValue(configuration.startingTier, 0)}
                    onChange={(event) =>
                      set("startingTier", Number(event.target.value))
                    }
                  />
                </Field>
                <Field label="Lookback in Wochen">
                  <input
                    type="number"
                    min={1}
                    max={12}
                    value={numberValue(configuration.lookbackWeeks, 1)}
                    onChange={(event) =>
                      set("lookbackWeeks", Number(event.target.value))
                    }
                  />
                </Field>
                <Field label="Mindestens geschlossene Trades">
                  <input
                    type="number"
                    min={1}
                    max={1000}
                    value={numberValue(configuration.minimumClosedTrades, 5)}
                    onChange={(event) =>
                      set("minimumClosedTrades", Number(event.target.value))
                    }
                  />
                </Field>
                <Field label="Verlustschwelle (%)">
                  <input
                    value={textValue(configuration.lossThresholdPercent, "2")}
                    onChange={(event) =>
                      set("lossThresholdPercent", event.target.value)
                    }
                  />
                </Field>
                <Field label="Gewinnschwelle (%)">
                  <input
                    value={textValue(configuration.profitThresholdPercent, "2")}
                    onChange={(event) =>
                      set("profitThresholdPercent", event.target.value)
                    }
                  />
                </Field>
                <Field label="Schwacher Kanal">
                  <select
                    value={textValue(configuration.weakChannelAction, "reduce")}
                    onChange={(event) =>
                      set("weakChannelAction", event.target.value)
                    }
                  >
                    <option value="none">Keine Sonderaktion</option>
                    <option value="reduce">Risiko reduzieren</option>
                    <option value="block">Nach schwachen Wochen sperren</option>
                  </select>
                </Field>
                <Field label="Schwache Wochen bis Sperre">
                  <input
                    type="number"
                    min={1}
                    max={52}
                    value={numberValue(configuration.weakWeeksBeforeBlock, 3)}
                    onChange={(event) =>
                      set("weakWeeksBeforeBlock", Number(event.target.value))
                    }
                  />
                </Field>
                <Toggle
                  checked={configuration.manuallyBlocked === true}
                  onChange={(value) => set("manuallyBlocked", value)}
                  label="Pfad manuell sperren"
                />
              </div>
              <p className="builder-info">
                Die Stufe wird getrennt pro Kanal, Börsenkonto und
                Risiko-Baustein geführt. Eine andere Börsenroute kann dadurch
                unabhängig reagieren.
              </p>
            </>
          )}
          {kind === "account" && (
            <div className="builder-field-grid">
              <Field label="Börsenkonto">
                <select
                  value={textValue(configuration.accountId)}
                  onChange={(event) => set("accountId", event.target.value)}
                >
                  {trading?.accounts.map((account) => (
                    <option key={account.id} value={account.id}>
                      {account.name} · {account.exchange} · {account.mode}
                    </option>
                  ))}
                </select>
              </Field>
              <Field
                label="Maximale gleichzeitige Positionen"
                hint="Diese Grenze gilt für das gesamte konkrete Börsenkonto – über alle Strategien hinweg."
              >
                <input
                  type="number"
                  min={1}
                  max={20}
                  value={accountLimit}
                  onChange={(event) =>
                    setAccountLimit(Number(event.target.value))
                  }
                />
              </Field>
              {selectedAccount && (
                <div
                  className={`account-inline-status ${selectedAccount.killSwitchActive ? "danger" : ""}`}
                >
                  <strong>{selectedAccount.status}</strong>
                  <span>
                    {selectedAccount.killSwitchActive
                      ? selectedAccount.killSwitchReason || "Kontosperre aktiv"
                      : `${selectedAccount.maxConcurrentPositions} Positionen maximal`}
                  </span>
                </div>
              )}
            </div>
          )}
          {kind === "output" && (
            <Field label="Ausgabe">
              <select
                value={textValue(configuration.mode, "audit_only")}
                onChange={(event) => set("mode", event.target.value)}
              >
                <option value="audit_only">Nur Audit & Journal</option>
                <option value="telegram_xml">XML an Telegram-Ziel</option>
                <option value="telegram_original">
                  Original an Telegram-Ziel
                </option>
                <option value="none">Keine zusätzliche Ausgabe</option>
              </select>
            </Field>
          )}
          {archiveConfirmation && (
            <Alert className="builder-delete-confirmation">
              <AlertTriangle />
              <AlertDescription>
                <strong>„{name}“ aus der aktiven Bibliothek archivieren?</strong>
                <p>
                  Der Baustein und seine Verbindungen werden aus dem aktiven
                  Canvas entfernt. Alte Revisionen bleiben für Audit und
                  Wiederherstellung unverändert erhalten.
                </p>
                <span>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={() => setArchiveConfirmation(false)}
                  >
                    Abbrechen
                  </Button>
                  <Button
                    type="button"
                    variant="destructive"
                    size="sm"
                    onClick={() => void archiveResource()}
                  >
                    Ja, dauerhaft archivieren
                  </Button>
                </span>
              </AlertDescription>
            </Alert>
          )}
          {deleteConfirmation && (
            <Alert variant="destructive" className="builder-delete-confirmation">
              <AlertTriangle />
              <AlertDescription>
                <strong>„{name}“ unwiderruflich aus der Bibliothek löschen?</strong>
                <p>
                  Das ist nur möglich, wenn keine aktive oder historische
                  Workflowrevision eine Version dieses Bausteins verwendet.
                  Verwendete Bausteine können aus Auditgründen nur archiviert
                  werden.
                </p>
                <span>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={() => setDeleteConfirmation(false)}
                  >
                    Abbrechen
                  </Button>
                  <Button
                    type="button"
                    variant="destructive"
                    size="sm"
                    onClick={() => void deleteResource()}
                  >
                    Ja, endgültig löschen
                  </Button>
                </span>
              </AlertDescription>
            </Alert>
          )}
        </div>
        <DialogFooter className="builder-modal-footer">
          {onDeleteNode && (
            <Button
              type="button"
              variant="outline"
              disabled={saving}
              onClick={onDeleteNode}
            >
              <Archive data-icon="inline-start" /> Nur vom Canvas lösen
            </Button>
          )}
          {onArchiveResource && (
            <Button
              type="button"
              variant="outline"
              disabled={saving}
              onClick={() => setArchiveConfirmation(true)}
            >
              <Archive data-icon="inline-start" /> Dauerhaft archivieren
            </Button>
          )}
          {onDeleteResource && (
            <Button
              type="button"
              variant="destructive"
              disabled={saving}
              onClick={() => setDeleteConfirmation(true)}
            >
              <Trash2 data-icon="inline-start" /> Endgültig löschen
            </Button>
          )}
          <span />
          <Button type="button" variant="outline" onClick={onClose}>
            Abbrechen
          </Button>
          <Button
            type="button"
            disabled={saving || !name.trim()}
            onClick={submit}
          >
            {saving ? "Aktiviere…" : "Version speichern & aktivieren"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

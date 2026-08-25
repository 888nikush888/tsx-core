import {
  Children,
  isValidElement,
  useEffect,
  useMemo,
  useState,
  type ReactElement,
  type ReactNode,
} from "react";
import { AlertTriangle, Archive, Check } from "lucide-react";
import { apiFetch } from "@/lib/api";
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
  type TradingSnapshot,
  type WorkflowKind,
  type WorkflowResource,
} from "./types";

type ResourceEditorProps = {
  open: boolean;
  kind: WorkflowKind;
  resource: WorkflowResource | null;
  trading: TradingSnapshot | null;
  onClose: () => void;
  onSave: (value: {
    name: string;
    description: string;
    configuration: Record<string, unknown>;
  }) => Promise<boolean>;
  onDeleteNode?: () => Promise<void>;
  onConfigureAccount?: (accountId: string, maximum: number) => Promise<void>;
};

async function requestJson(url: string, init?: RequestInit) {
  const response = await apiFetch(url, init);
  const payload = await response.json().catch(() => ({}));
  if (!response.ok)
    throw new Error(
      payload.error || `Anfrage fehlgeschlagen (${response.status}).`,
    );
  return payload;
}

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

function applyParserDraft(
  configuration: Record<string, unknown>,
  templateContent: string,
): void {
  const templateName = String(configuration.templateName || "").trim();
  if (!/^[a-zA-Z0-9_-]{1,64}$/.test(templateName))
    throw new Error("Der Vorlagenname ist ungültig.");
  if (!templateContent.trim())
    throw new Error("Der Parser-Prompt darf nicht leer sein.");
  configuration.prompt = templateContent.trim();
  configuration.saveToFile = false;
}

async function publishStrategyDraft(
  configuration: Record<string, unknown>,
  trading: TradingSnapshot | null,
  nativeJson: string,
): Promise<void> {
  const selected = trading?.strategies.find(
    (item) => item.id === configuration.strategyVersionId,
  );
  if (!selected)
    throw new Error("Die gewählte Strategieversion existiert nicht mehr.");
  const draft = await requestJson("/api/trading/strategies", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      strategyId: selected.strategyId,
      name: selected.name,
      description: selected.description,
      configuration: JSON.parse(nativeJson),
    }),
  });
  const published = await requestJson("/api/trading/strategies/publish", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ id: draft.result.id }),
  });
  configuration.strategyVersionId = published.result.id;
}

async function publishContractDraft(
  configuration: Record<string, unknown>,
  trading: TradingSnapshot | null,
  nativeJson: string,
): Promise<void> {
  const parent = trading?.signalContracts.find((contract) =>
    contract.versions.some(
      (version) => version.id === configuration.contractVersionId,
    ),
  );
  const source = parent?.versions.find(
    (version) => version.id === configuration.contractVersionId,
  );
  if (!parent || !source)
    throw new Error("Die gewählte Vertragsversion existiert nicht mehr.");
  const draft = await requestJson("/api/trading/signal-contracts/versions", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ contractId: parent.id, sourceVersionId: source.id }),
  });
  await requestJson("/api/trading/signal-contracts/update", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      contractId: parent.id,
      versionId: draft.result.id,
      name: parent.name,
      description: parent.description,
      definition: JSON.parse(nativeJson),
    }),
  });
  const published = await requestJson("/api/trading/signal-contracts/publish", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ versionId: draft.result.id }),
  });
  configuration.contractVersionId = published.result.id;
}

async function createSchemaDraft(
  configuration: Record<string, unknown>,
  schemaDraft: Record<string, unknown>,
): Promise<void> {
  const id = String(schemaDraft.id || "").trim();
  if (!id || id === schemaDraft.originalId) {
    throw new Error(
      "Änderungen an einem verwendeten Signal-Schema benötigen eine neue eindeutige Schema-ID.",
    );
  }
  const created = await requestJson("/api/trading/signal-schemas", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      id,
      name: schemaDraft.name,
      description: schemaDraft.description,
      contractVersionId: schemaDraft.contractVersionId,
      templateName: schemaDraft.templateName,
      enabled: schemaDraft.enabled !== false,
    }),
  });
  configuration.schemaId = created.result.id;
}

export function defaultConfiguration(
  kind: WorkflowKind,
  trading: TradingSnapshot | null,
): Record<string, unknown> {
  const strategy = trading?.strategies.find(
    (item) => item.status === "published",
  );
  const schema = trading?.signalSchemas.find((item) => item.enabled);
  const contract = trading?.signalContracts
    .flatMap((item) => item.versions)
    .find((item) => item.status === "published");
  const account = trading?.accounts[0];
  const defaults: Record<WorkflowKind, Record<string, unknown>> = {
    channel: { channelId: "" },
    content_filter: { allowedTypes: ["text"] },
    keyword_filter: { allowedKeywords: [], blockedKeywords: [] },
    regex: { patterns: [], mode: "all" },
    parser: { templateName: "default", timeoutMs: 120_000, saveToFile: false },
    schema: { schemaId: schema?.id || "" },
    contract: { contractVersionId: contract?.id || "" },
    dedupe: { enabled: true, cooldownHours: 24 },
    strategy: { strategyVersionId: strategy?.id || "" },
    sizing: {
      positionSizingMode: "equity_percent_margin",
      riskPerTradePercent: "5",
      maxAdaptiveRiskPercent: "10",
      maxPositionNotional: "1000000000",
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

function Field(props: { label: string; hint?: string; children: ReactNode }) {
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
}: {
  checked: boolean;
  onChange: (checked: boolean) => void;
  label: string;
}) {
  return (
    <Label className="builder-toggle">
      <Switch checked={checked} onCheckedChange={onChange} />
      {label}
    </Label>
  );
}

export function ResourceEditor({
  open,
  kind,
  resource,
  trading,
  onClose,
  onSave,
  onDeleteNode,
  onConfigureAccount,
}: ResourceEditorProps) {
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [configuration, setConfiguration] = useState<Record<string, unknown>>(
    {},
  );
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [templates, setTemplates] = useState<Record<string, string>>({});
  const [templateContent, setTemplateContent] = useState("");
  const [nativeJson, setNativeJson] = useState("");
  const [nativeTouched, setNativeTouched] = useState(false);
  const [schemaDraft, setSchemaDraft] = useState<Record<string, unknown>>({});
  const [schemaTouched, setSchemaTouched] = useState(false);
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
      setNativeJson(
        selected ? JSON.stringify(selected.configuration, null, 2) : "",
      );
    } else if (kind === "contract") {
      const selected = trading?.signalContracts
        .flatMap((contract) => contract.versions)
        .find((item) => item.id === nextConfiguration.contractVersionId);
      setNativeJson(
        selected ? JSON.stringify(selected.definition, null, 2) : "",
      );
    } else setNativeJson("");
    setNativeTouched(false);
    if (kind === "schema") {
      const selected = trading?.signalSchemas.find(
        (item) => item.id === nextConfiguration.schemaId,
      );
      setSchemaDraft(
        selected
          ? {
              id: selected.id,
              originalId: selected.id,
              name: selected.name,
              description: selected.description,
              contractVersionId: selected.contractVersionId,
              templateName: selected.templateName,
              enabled: selected.enabled,
            }
          : {},
      );
    } else setSchemaDraft({});
    setSchemaTouched(false);
    if (kind === "parser") {
      void requestJson("/api/templates")
        .then((payload) => {
          const loaded = payload.templates || {};
          setTemplates(loaded);
          setTemplateContent(
            typeof nextConfiguration.prompt === "string"
              ? nextConfiguration.prompt
              : String(
                  loaded[String(nextConfiguration.templateName || "default")] ||
                    "",
                ),
          );
        })
        .catch((reason) =>
          setError(reason instanceof Error ? reason.message : String(reason)),
        );
    }
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
      const nextConfiguration = structuredClone(configuration);
      if (kind === "parser")
        applyParserDraft(nextConfiguration, templateContent);
      if (kind === "strategy" && nativeTouched)
        await publishStrategyDraft(nextConfiguration, trading, nativeJson);
      if (kind === "contract" && nativeTouched)
        await publishContractDraft(nextConfiguration, trading, nativeJson);
      if (kind === "schema" && schemaTouched)
        await createSchemaDraft(nextConfiguration, schemaDraft);
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
                value={String(configuration.channelId || "")}
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
                  value={String(configuration.mode || "all")}
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
                <Field label="Prompt-Vorlage">
                  <input
                    list="parser-template-names"
                    value={String(configuration.templateName || "default")}
                    onChange={(event) => {
                      set("templateName", event.target.value);
                      setTemplateContent(templates[event.target.value] || "");
                    }}
                  />
                  <datalist id="parser-template-names">
                    {Object.keys(templates).map((template) => (
                      <option key={template} value={template} />
                    ))}
                  </datalist>
                </Field>
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
                    value={String(configuration.primaryModel || "")}
                    placeholder="Globales Modell verwenden"
                    onChange={(event) =>
                      set("primaryModel", event.target.value || undefined)
                    }
                  />
                </Field>
                <Field label="Fallback-Modell">
                  <input
                    value={String(configuration.fallbackModel || "")}
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
            <>
              <Field label="Aktives Signal-Schema">
                <select
                  value={String(configuration.schemaId || "")}
                  onChange={(event) => {
                    const id = event.target.value;
                    set("schemaId", id);
                    const selected = trading?.signalSchemas.find(
                      (item) => item.id === id,
                    );
                    setSchemaDraft(
                      selected
                        ? {
                            id: selected.id,
                            originalId: selected.id,
                            name: selected.name,
                            description: selected.description,
                            contractVersionId: selected.contractVersionId,
                            templateName: selected.templateName,
                            enabled: selected.enabled,
                          }
                        : {},
                    );
                    setSchemaTouched(false);
                  }}
                >
                  {trading?.signalSchemas
                    .filter((item) => item.enabled)
                    .map((item) => (
                      <option key={item.id} value={item.id}>
                        {item.name} · {item.id}
                      </option>
                    ))}
                </select>
              </Field>
              <div className="builder-field-grid three">
                <Field
                  label="Neue Schema-ID"
                  hint="Nur ändern, wenn eine neue, unveränderliche Schema-Zuordnung entstehen soll."
                >
                  <input
                    value={String(schemaDraft.id || "")}
                    onChange={(event) => {
                      setSchemaDraft((previous) => ({
                        ...previous,
                        id: event.target.value,
                      }));
                      setSchemaTouched(true);
                    }}
                  />
                </Field>
                <Field label="Schema-Name">
                  <input
                    value={String(schemaDraft.name || "")}
                    onChange={(event) => {
                      setSchemaDraft((previous) => ({
                        ...previous,
                        name: event.target.value,
                      }));
                      setSchemaTouched(true);
                    }}
                  />
                </Field>
                <Field label="Prompt-Vorlage">
                  <input
                    value={String(schemaDraft.templateName || "")}
                    onChange={(event) => {
                      setSchemaDraft((previous) => ({
                        ...previous,
                        templateName: event.target.value,
                      }));
                      setSchemaTouched(true);
                    }}
                  />
                </Field>
                <Field
                  label="Standard-Vertragsversion"
                  hint="Fallback für Alt-Routen; im visuellen Workflow entscheidet der separate Vertragsbaustein."
                >
                  <select
                    value={String(schemaDraft.contractVersionId || "")}
                    onChange={(event) => {
                      setSchemaDraft((previous) => ({
                        ...previous,
                        contractVersionId: event.target.value,
                      }));
                      setSchemaTouched(true);
                    }}
                  >
                    {trading?.signalContracts.flatMap((contract) =>
                      contract.versions
                        .filter((version) => version.status === "published")
                        .map((version) => (
                          <option key={version.id} value={version.id}>
                            {contract.name} · v{version.version}
                          </option>
                        )),
                    )}
                  </select>
                </Field>
                <Field label="Beschreibung">
                  <input
                    value={String(schemaDraft.description || "")}
                    onChange={(event) => {
                      setSchemaDraft((previous) => ({
                        ...previous,
                        description: event.target.value,
                      }));
                      setSchemaTouched(true);
                    }}
                  />
                </Field>
                <Toggle
                  checked={schemaDraft.enabled !== false}
                  onChange={(value) => {
                    setSchemaDraft((previous) => ({
                      ...previous,
                      enabled: value,
                    }));
                    setSchemaTouched(true);
                  }}
                  label="Schema aktiv"
                />
              </div>
            </>
          )}
          {kind === "contract" && (
            <>
              <Field label="Veröffentlichte Vertragsversion">
                <select
                  value={String(configuration.contractVersionId || "")}
                  onChange={(event) => {
                    const id = event.target.value;
                    set("contractVersionId", id);
                    const selected = trading?.signalContracts
                      .flatMap((contract) => contract.versions)
                      .find((version) => version.id === id);
                    setNativeJson(
                      selected
                        ? JSON.stringify(selected.definition, null, 2)
                        : "",
                    );
                    setNativeTouched(false);
                  }}
                >
                  {trading?.signalContracts.flatMap((contract) =>
                    contract.versions
                      .filter((version) => version.status === "published")
                      .map((version) => (
                        <option key={version.id} value={version.id}>
                          {contract.name} · v{version.version}
                        </option>
                      )),
                  )}
                </select>
              </Field>
              <Field
                label="Vertragsdefinition"
                hint="Eine Änderung erzeugt und veröffentlicht eine neue Vertragsversion; bestehende Revisionen bleiben unverändert."
              >
                <textarea
                  className="code-input native-json-input"
                  value={nativeJson}
                  onChange={(event) => {
                    setNativeJson(event.target.value);
                    setNativeTouched(true);
                  }}
                />
              </Field>
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
              <Field label="Veröffentlichte Strategie">
                <select
                  value={String(configuration.strategyVersionId || "")}
                  onChange={(event) => {
                    const id = event.target.value;
                    set("strategyVersionId", id);
                    const selected = trading?.strategies.find(
                      (item) => item.id === id,
                    );
                    setNativeJson(
                      selected
                        ? JSON.stringify(selected.configuration, null, 2)
                        : "",
                    );
                    setNativeTouched(false);
                  }}
                >
                  {trading?.strategies
                    .filter((item) => item.status === "published")
                    .map((item) => (
                      <option key={item.id} value={item.id}>
                        {item.name} · v{item.version}
                      </option>
                    ))}
                </select>
              </Field>
              <Field
                label="Strategiedefinition"
                hint="Eine Änderung erzeugt und veröffentlicht eine neue Strategieversion; bestehende Revisionen bleiben unverändert."
              >
                <textarea
                  className="code-input native-json-input"
                  value={nativeJson}
                  onChange={(event) => {
                    setNativeJson(event.target.value);
                    setNativeTouched(true);
                  }}
                />
              </Field>
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
                  value={String(configuration.riskPerTradePercent || "5")}
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
                  value={String(configuration.maxAdaptiveRiskPercent || "10")}
                  onChange={(event) =>
                    set("maxAdaptiveRiskPercent", event.target.value)
                  }
                />
              </Field>
              <Field label="Max. Leverage">
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
                    value={String(configuration.mode || "automatic")}
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
                    value={String(configuration.lossThresholdPercent || "2")}
                    onChange={(event) =>
                      set("lossThresholdPercent", event.target.value)
                    }
                  />
                </Field>
                <Field label="Gewinnschwelle (%)">
                  <input
                    value={String(configuration.profitThresholdPercent || "2")}
                    onChange={(event) =>
                      set("profitThresholdPercent", event.target.value)
                    }
                  />
                </Field>
                <Field label="Schwacher Kanal">
                  <select
                    value={String(configuration.weakChannelAction || "reduce")}
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
                  value={String(configuration.accountId || "")}
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
                value={String(configuration.mode || "audit_only")}
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
        </div>
        <DialogFooter className="builder-modal-footer">
          {onDeleteNode && (
            <Button
              type="button"
              variant="destructive"
              disabled={saving}
              onClick={onDeleteNode}
            >
              <Archive data-icon="inline-start" /> Baustein aus Workflow
              entfernen
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

import { useMemo, useState, type ReactNode } from "react"
import { Copy, FileCheck2, Plus, Save, Trash2 } from "lucide-react"
import { apiFetch } from "@/lib/api"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Switch } from "@/components/ui/switch"

const API_BASE = window.location.origin

const EMPTY_DEFINITION = {
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
    maximumItems: null,
    sequentialIds: true,
  },
  stopLossPath: "stoploss",
  leveragePath: "leverage",
  riskPercentPath: "",
  averagingPricePath: "",
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
}

async function mutate(path: string, body: unknown, method = "POST", headers: Record<string, string> = {}) {
  const response = await apiFetch(`${API_BASE}${path}`, {
    method,
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body),
  })
  const payload = await response.json().catch(() => ({}))
  if (!response.ok) throw new Error(payload.error || `Vertragsanfrage fehlgeschlagen (${response.status}).`)
  return payload.result
}

function Field({ label, children }: Readonly<{ label: string; children: ReactNode }>) {
  return <div className="space-y-2"><Label>{label}</Label>{children}</div>
}

function TextField({ label, value, onChange, placeholder = "" }: Readonly<{
  label: string
  value: string
  onChange: (value: string) => void
  placeholder?: string
}>) {
  return <Field label={label}><Input value={value} placeholder={placeholder} onChange={event => onChange(event.target.value)} /></Field>
}

function SelectField({ label, value, options, onChange }: Readonly<{
  label: string
  value: string
  options: Array<{ value: string; label: string }>
  onChange: (value: string) => void
}>) {
  return <Field label={label}><Select value={value} onValueChange={onChange}><SelectTrigger><SelectValue /></SelectTrigger><SelectContent>{options.map(option => <SelectItem key={option.value} value={option.value}>{option.label}</SelectItem>)}</SelectContent></Select></Field>
}

function Toggle({ label, checked, onChange }: Readonly<{
  label: string
  checked: boolean
  onChange: (value: boolean) => void
}>) {
  return <label className="flex items-center justify-between gap-3 rounded-md border px-3 py-2 text-sm"><span>{label}</span><Switch checked={checked} onCheckedChange={onChange} /></label>
}

function normalizeDefinition(definition: any) {
  const copy = structuredClone(definition)
  for (const key of ["leveragePath", "riskPercentPath", "averagingPricePath"]) {
    if (!copy[key]) delete copy[key]
  }
  if (copy.entry.mode !== "typed") {
    delete copy.entry.typePath
    copy.entry.marketValues = []
    copy.entry.rangeValues = []
  }
  for (const field of copy.additionalFields) {
    field.allowedValues = Array.isArray(field.allowedValues) ? field.allowedValues : []
    for (const key of ["minimum", "maximum", "maximumLength", "pattern"]) {
      if (field[key] === "" || field[key] === undefined) delete field[key]
    }
  }
  return copy
}

export function SignalContractManager({ data, busy, run }: Readonly<{ data: any; busy: string; run: any }>) {
  const contracts = useMemo(
    () => Array.isArray(data.signalContracts) ? data.signalContracts : [],
    [data.signalContracts],
  )
  const [contractId, setContractId] = useState("")
  const [versionId, setVersionId] = useState("")
  const [form, setForm] = useState<any>({
    id: "",
    name: "",
    description: "",
    definition: structuredClone(EMPTY_DEFINITION),
  })
  const [preview, setPreview] = useState({
    xml: "<signal><action>LONG</action><pair>BTCUSDT</pair><entry_range><min>60000</min><max>60100</max></entry_range><targets><target id=\"1\">62000</target></targets><stoploss>59000</stoploss></signal>",
    sourceText: "LONG BTCUSDT Entry 60000-60100 TP 62000 SL 59000",
  })
  const [previewResult, setPreviewResult] = useState("")
  const selectedContract = contracts.find((contract: any) => contract.id === contractId)
  const selectedVersion = selectedContract?.versions.find((version: any) => version.id === versionId)
  const referencingProfiles = (Array.isArray(data.signalSchemas) ? data.signalSchemas : [])
    .filter((schema: any) => schema.contractVersionId === versionId)
  const publishedVersions = useMemo(
    () => contracts.flatMap((contract: any) => contract.versions.filter((version: any) => version.status === "published")),
    [contracts],
  )

  const selectVersion = (contract: any, version: any) => {
    setContractId(contract.id)
    setVersionId(version.id)
    setForm({
      id: contract.id,
      name: contract.name,
      description: contract.description,
      definition: structuredClone(version.definition),
    })
    setPreviewResult("")
  }
  const createNew = () => {
    setContractId("")
    setVersionId("")
    setForm({ id: "", name: "", description: "", definition: structuredClone(EMPTY_DEFINITION) })
    setPreviewResult("")
  }
  const patchDefinition = (section: string, key: string, value: unknown) => {
    setForm((current: any) => ({
      ...current,
      definition: {
        ...current.definition,
        [section]: { ...current.definition[section], [key]: value },
      },
    }))
  }
  const save = async () => {
    const definition = normalizeDefinition(form.definition)
    const operation = selectedVersion?.status === "draft"
      ? () => mutate("/api/trading/signal-contracts/update", {
          contractId,
          versionId,
          name: form.name,
          description: form.description,
          definition,
        })
      : () => mutate("/api/trading/signal-contracts", {
          id: form.id,
          name: form.name,
          description: form.description,
          definition,
        })
    const saved = await run("save-contract", operation, selectedVersion?.status === "draft" ? "Vertragsentwurf gespeichert." : "Vertragsentwurf angelegt.")
    if (saved) createNew()
  }
  const previewContract = async () => {
    setPreviewResult("")
    try {
      const result = await mutate("/api/trading/signal-contracts/validate", {
        definition: normalizeDefinition(form.definition),
        ...preview,
      })
      setPreviewResult(`Gültig: ${result.action} ${result.pair} · ${result.execution?.targets?.length || 0} TP`)
    } catch (error) {
      setPreviewResult(error instanceof Error ? error.message : "Validierung fehlgeschlagen.")
    }
  }
  const addAdditionalField = () => {
    setForm((current: any) => ({
      ...current,
      definition: {
        ...current.definition,
        additionalFields: [...current.definition.additionalFields, {
          path: "timeframe",
          type: "text",
          required: true,
          allowedValues: [],
          pattern: "",
        }],
      },
    }))
  }
  const updateAdditionalField = (index: number, key: string, value: unknown) => {
    setForm((current: any) => ({
      ...current,
      definition: {
        ...current.definition,
        additionalFields: current.definition.additionalFields.map((field: any, fieldIndex: number) =>
          fieldIndex === index ? { ...field, [key]: value } : field),
      },
    }))
  }
  const removeAdditionalField = (index: number) => {
    setForm((current: any) => ({
      ...current,
      definition: {
        ...current.definition,
        additionalFields: current.definition.additionalFields.filter(
          (_field: any, fieldIndex: number) => fieldIndex !== index,
        ),
      },
    }))
  }
  const deletePublishedVersion = async () => {
    if (!window.confirm("Diese veröffentlichte Vertragsversion endgültig löschen? Das ist nur möglich, wenn kein Signal-Schema-Profil mehr darauf verweist.")) return
    const deleted = await run(
      "delete-contract-version",
      () => mutate(
        "/api/trading/signal-contracts/versions",
        { versionId },
        "DELETE",
        { "X-Destructive-Confirmation": "delete-signal-contract-version" },
      ),
      "Vertragsversion endgültig gelöscht.",
    )
    if (deleted) createNew()
  }
  const deleteDraft = async () => {
    if (!window.confirm("Diesen unveröffentlichten Vertragsentwurf endgültig löschen?")) return
    const deleted = await run(
      "delete-contract",
      () => mutate(
        "/api/trading/signal-contracts/drafts",
        { versionId },
        "DELETE",
        { "X-Destructive-Confirmation": "delete-signal-contract-draft" },
      ),
      "Vertragsentwurf gelöscht.",
    )
    if (deleted) createNew()
  }

  return <div className="space-y-5">
    <Card>
      <CardHeader className="flex-row items-start justify-between gap-4">
        <div><CardTitle>Versionierte Signalverträge</CardTitle><CardDescription>Verträge definieren XML-Struktur, Normalisierung, Geometrie und Quelltext-Erdung ohne ausführbaren Nutzer-Code.</CardDescription></div>
        <Button variant="outline" onClick={createNew}><Plus className="mr-2 h-4 w-4" />Neuer Vertrag</Button>
      </CardHeader>
      <CardContent className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
        {contracts.map((contract: any) => <div key={contract.id} className="rounded-md border p-3">
          <div className="font-medium">{contract.name}</div>
          <div className="mt-1 text-xs text-muted-foreground">{contract.id}</div>
          <div className="mt-3 flex flex-wrap gap-2">
            {contract.versions.map((version: any) => <Button key={version.id} size="sm" variant={versionId === version.id ? "default" : "outline"} onClick={() => selectVersion(contract, version)}>
              v{version.version} <Badge variant="secondary" className="ml-2">{version.status}</Badge>
            </Button>)}
          </div>
        </div>)}
      </CardContent>
    </Card>

    <Card>
      <CardHeader><CardTitle>{selectedVersion ? `${form.name} · v${selectedVersion.version}` : "Vertragsentwurf erstellen"}</CardTitle><CardDescription>Veröffentlichte Versionen sind unveränderlich. Änderungen erfolgen immer in einem neuen Entwurf.</CardDescription></CardHeader>
      <CardContent className="space-y-6">
        <div className="grid gap-4 md:grid-cols-3">
          <TextField label="Kennung" value={form.id} onChange={id => setForm({ ...form, id: id.toLowerCase() })} />
          <TextField label="Anzeigename" value={form.name} onChange={name => setForm({ ...form, name })} />
          <TextField label="Beschreibung" value={form.description} onChange={description => setForm({ ...form, description })} />
        </div>

        <section className="space-y-4 rounded-md border p-4">
          <h3 className="font-medium">Feldzuordnung</h3>
          <div className="grid gap-4 md:grid-cols-3">
            <TextField label="Action-Pfad" value={form.definition.actionPath} onChange={value => setForm({ ...form, definition: { ...form.definition, actionPath: value } })} />
            <TextField label="Paar-Pfad" value={form.definition.pairPath} onChange={value => setForm({ ...form, definition: { ...form.definition, pairPath: value } })} />
            <TextField label="Stop-Loss-Pfad" value={form.definition.stopLossPath} onChange={value => setForm({ ...form, definition: { ...form.definition, stopLossPath: value } })} />
            <TextField label="Leverage-Pfad (optional)" value={form.definition.leveragePath || ""} onChange={value => setForm({ ...form, definition: { ...form.definition, leveragePath: value } })} />
            <TextField label="Risiko-Pfad (optional)" value={form.definition.riskPercentPath || ""} onChange={value => setForm({ ...form, definition: { ...form.definition, riskPercentPath: value } })} />
            <TextField label="Averaging-Pfad (optional)" value={form.definition.averagingPricePath || ""} onChange={value => setForm({ ...form, definition: { ...form.definition, averagingPricePath: value } })} />
          </div>
        </section>

        <section className="space-y-4 rounded-md border p-4">
          <h3 className="font-medium">Entry und Ziele</h3>
          <div className="grid gap-4 md:grid-cols-3">
            <SelectField label="Entry-Modus" value={form.definition.entry.mode} options={[
              { value: "optional_range", label: "Optionale Range / sonst Market" },
              { value: "required_range", label: "Range verpflichtend" },
              { value: "typed", label: "Über Entry-Typ gesteuert" },
            ]} onChange={value => patchDefinition("entry", "mode", value)} />
            {form.definition.entry.mode === "typed" && <>
              <TextField label="Entry-Typ-Pfad" value={form.definition.entry.typePath || "entry_type"} onChange={value => patchDefinition("entry", "typePath", value)} />
              <TextField label="Market-Werte" value={form.definition.entry.marketValues.join(",")} onChange={value => patchDefinition("entry", "marketValues", value.split(",").map(item => item.trim()).filter(Boolean))} />
              <TextField label="Range-Werte" value={form.definition.entry.rangeValues.join(",")} onChange={value => patchDefinition("entry", "rangeValues", value.split(",").map(item => item.trim()).filter(Boolean))} />
            </>}
            <TextField label="Entry-Min-Pfad" value={form.definition.entry.minimumPath} onChange={value => patchDefinition("entry", "minimumPath", value)} />
            <TextField label="Entry-Max-Pfad" value={form.definition.entry.maximumPath} onChange={value => patchDefinition("entry", "maximumPath", value)} />
            <TextField label="Targets-Container" value={form.definition.targets.containerPath} onChange={value => patchDefinition("targets", "containerPath", value)} />
            <TextField label="Target-Element" value={form.definition.targets.itemTag} onChange={value => patchDefinition("targets", "itemTag", value)} />
            <SelectField label="Target-Form" value={form.definition.targets.shape} options={[
              { value: "scalar", label: "Einzelwert" },
              { value: "range", label: "Range" },
            ]} onChange={value => patchDefinition("targets", "shape", value)} />
            <TextField label="Target-Min-Pfad" value={form.definition.targets.minimumPath} onChange={value => patchDefinition("targets", "minimumPath", value)} />
            <TextField label="Target-Max-Pfad" value={form.definition.targets.maximumPath} onChange={value => patchDefinition("targets", "maximumPath", value)} />
            <Field label="Anzahl Targets (Min. / Max.; leer = unbegrenzt)"><div className="grid grid-cols-2 gap-2"><Input type="number" min={1} value={form.definition.targets.minimumItems} onChange={event => patchDefinition("targets", "minimumItems", Number(event.target.value))} /><Input type="number" min={form.definition.targets.minimumItems} value={form.definition.targets.maximumItems ?? ""} placeholder="unbegrenzt" onChange={event => patchDefinition("targets", "maximumItems", event.target.value === "" ? null : Number(event.target.value))} /></div></Field>
          </div>
          <Toggle label="Sequenzielle Target-IDs erzwingen" checked={form.definition.targets.sequentialIds} onChange={value => patchDefinition("targets", "sequentialIds", value)} />
        </section>

        <section className="space-y-4 rounded-md border p-4">
          <div className="flex items-center justify-between"><h3 className="font-medium">Zusätzliche Validierungsfelder</h3><Button size="sm" variant="outline" onClick={addAdditionalField}><Plus className="mr-2 h-4 w-4" />Feld</Button></div>
          {form.definition.additionalFields.map((field: any, index: number) => <div key={`${index}-${field.path}`} className="grid gap-3 rounded-md border p-3 md:grid-cols-5">
            <TextField label="Pfad" value={field.path} onChange={value => updateAdditionalField(index, "path", value)} />
            <SelectField label="Typ" value={field.type} options={["text", "decimal", "integer", "boolean"].map(value => ({ value, label: value }))} onChange={value => updateAdditionalField(index, "type", value)} />
            <TextField label="Erlaubte Werte" value={field.allowedValues.join(",")} onChange={value => updateAdditionalField(index, "allowedValues", value.split(",").map(item => item.trim()).filter(Boolean))} />
            <TextField label="Sicheres Muster" value={field.pattern || ""} onChange={value => updateAdditionalField(index, "pattern", value)} />
            <div className="flex items-end gap-2"><Toggle label="Pflicht" checked={field.required} onChange={value => updateAdditionalField(index, "required", value)} /><Button size="icon" variant="ghost" onClick={() => removeAdditionalField(index)}><Trash2 className="h-4 w-4" /></Button></div>
          </div>)}
        </section>

        <div className="grid gap-4 lg:grid-cols-2">
          <section className="space-y-2 rounded-md border p-4">
            <h3 className="mb-3 font-medium">Geometrie</h3>
            {Object.entries(form.definition.geometry).map(([key, value]) => <Toggle key={key} label={key} checked={Boolean(value)} onChange={checked => patchDefinition("geometry", key, checked)} />)}
          </section>
          <section className="space-y-2 rounded-md border p-4">
            <h3 className="mb-3 font-medium">Quelltext-Erdung</h3>
            {Object.entries(form.definition.grounding).map(([key, value]) => <Toggle key={key} label={key} checked={Boolean(value)} onChange={checked => patchDefinition("grounding", key, checked)} />)}
          </section>
        </div>

        <section className="space-y-3 rounded-md border p-4">
          <h3 className="font-medium">Sichere Vorschau</h3>
          <textarea className="min-h-28 w-full rounded-md border bg-background p-3 font-mono text-xs" value={preview.xml} onChange={event => setPreview({ ...preview, xml: event.target.value })} />
          <textarea className="min-h-20 w-full rounded-md border bg-background p-3 text-sm" value={preview.sourceText} onChange={event => setPreview({ ...preview, sourceText: event.target.value })} />
          <div className="flex items-center gap-3"><Button variant="outline" onClick={() => void previewContract()}><FileCheck2 className="mr-2 h-4 w-4" />Validieren</Button>{previewResult && <output className="text-sm">{previewResult}</output>}</div>
        </section>

        <div className="flex flex-wrap gap-2">
          {(!selectedVersion || selectedVersion.status === "draft") && <Button disabled={Boolean(busy) || !form.id || !form.name} onClick={() => void save()}><Save className="mr-2 h-4 w-4" />Entwurf speichern</Button>}
          {selectedVersion?.status === "draft" && <Button variant="outline" disabled={Boolean(busy)} onClick={() => void run("publish-contract", () => mutate("/api/trading/signal-contracts/publish", { versionId }), "Vertragsversion veröffentlicht.")}>Veröffentlichen</Button>}
          {selectedVersion?.status === "published" && <Button variant="outline" disabled={Boolean(busy)} onClick={() => void run("new-contract-version", () => mutate("/api/trading/signal-contracts/versions", { contractId, sourceVersionId: versionId }), "Neue Vertragsversion als Entwurf angelegt.")}>Neue Version</Button>}
          {selectedVersion && <Button variant="outline" disabled={Boolean(busy)} onClick={() => {
            const id = window.prompt("Kennung der Kopie", `${contractId}-copy`)
            if (!id) return
            void run("duplicate-contract", () => mutate("/api/trading/signal-contracts/duplicate", { sourceVersionId: versionId, id, name: `${form.name} Kopie`, description: form.description }), "Vertrag dupliziert.")
          }}><Copy className="mr-2 h-4 w-4" />Duplizieren</Button>}
          {selectedVersion?.status === "published" && <Button variant="outline" disabled={Boolean(busy)} onClick={() => void run("archive-contract", () => mutate("/api/trading/signal-contracts/archive", { versionId }), "Vertragsversion archiviert.")}>Archivieren</Button>}
          {(selectedVersion?.status === "published" || selectedVersion?.status === "archived") && <Button variant="destructive" disabled={Boolean(busy)} onClick={() => void deletePublishedVersion()}><Trash2 className="mr-2 h-4 w-4" />Vertragsversion löschen</Button>}
          {selectedVersion?.status === "draft" && <Button variant="destructive" disabled={Boolean(busy)} onClick={() => void deleteDraft()}><Trash2 className="mr-2 h-4 w-4" />Entwurf löschen</Button>}
        </div>
        {selectedVersion && referencingProfiles.length > 0 && <p className="text-xs text-muted-foreground">
          Verknüpft mit {referencingProfiles.length} Signal-Schema-Profil(en): {referencingProfiles.map((schema: any) => schema.name).join(", ")}. Vor dem endgültigen Löschen diese Profile umstellen oder löschen.
        </p>}
        <p className="text-xs text-muted-foreground">{publishedVersions.length} veröffentlichte Vertragsversion(en) können mit Schema-Profilen verknüpft werden.</p>
      </CardContent>
    </Card>
  </div>
}

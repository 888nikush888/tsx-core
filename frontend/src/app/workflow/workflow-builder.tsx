import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react'
import {
  applyEdgeChanges, applyNodeChanges, Background, BackgroundVariant, Controls,
  MiniMap, Position, ReactFlow, type Connection, type Edge, type EdgeChange, type Node,
  type NodeChange, type NodeMouseHandler, type OnNodeDrag,
} from '@xyflow/react'
import {
  Activity, AlertTriangle, Check, FlaskConical, Plus, RefreshCw, Save, Search,
  ShieldCheck, Workflow, X,
} from 'lucide-react'
import { apiFetch } from '@/lib/api'
import { OperationsPanel } from './operations-panel'
import { ResourceEditor } from './resource-editor'
import {
  COLUMN_GAP, KIND_META, WORKFLOW_KINDS, type ExchangeCatalog, type TradingSnapshot,
  type WorkflowGraph, type WorkflowKind, type WorkflowResource, type WorkflowSnapshot,
} from './types'
import { ColumnHeaderNode, WorkflowNode, type WorkflowNodeData } from './workflow-node'
import { useModalFocus } from './use-modal-focus'

const nodeTypes = { workflow: WorkflowNode, columnHeader: ColumnHeaderNode }
const EMPTY_GRAPH: WorkflowGraph = { schemaVersion: 1, nodes: [], edges: [] }
const WORKFLOW_NODE_DIMENSIONS = { width: 236, height: 78 } as const
const COLUMN_HEADER_DIMENSIONS = { width: 236, height: 27 } as const
const WORKFLOW_HANDLE_SIZE = 9

function workflowHandles(kind: WorkflowKind): NonNullable<Node['handles']> {
  const edgeOffset = WORKFLOW_HANDLE_SIZE / 2
  const centerY = (WORKFLOW_NODE_DIMENSIONS.height - WORKFLOW_HANDLE_SIZE) / 2
  const handles: NonNullable<Node['handles']> = []
  if (kind !== 'channel') {
    handles.push({
      type: 'target', position: Position.Left, x: -edgeOffset, y: centerY,
      width: WORKFLOW_HANDLE_SIZE, height: WORKFLOW_HANDLE_SIZE,
    })
  }
  if (kind !== 'output') {
    handles.push({
      type: 'source', position: Position.Right,
      x: WORKFLOW_NODE_DIMENSIONS.width - edgeOffset, y: centerY,
      width: WORKFLOW_HANDLE_SIZE, height: WORKFLOW_HANDLE_SIZE,
    })
  }
  return handles
}

async function jsonRequest(url: string, init?: RequestInit) {
  const response = await apiFetch(url, init)
  const payload = await response.json().catch(() => ({}))
  if (!response.ok) throw new Error(payload.error || `Anfrage fehlgeschlagen (${response.status}).`)
  return payload
}

function summary(resource: WorkflowResource, trading: TradingSnapshot | null): string {
  const value: any = resource.configuration
  if (resource.kind === 'account') {
    const account = trading?.accounts.find(item => item.id === value.accountId)
    return account ? `${account.exchange} · ${account.mode} · max ${account.maxConcurrentPositions}` : String(value.accountId)
  }
  const summaries: Partial<Record<WorkflowKind, () => string>> = {
    channel: () => String(value.channelId),
    content_filter: () => `${value.allowedTypes?.length || 0} Inhaltstypen`,
    keyword_filter: () => `${value.allowedKeywords?.length || 0} erlaubt · ${value.blockedKeywords?.length || 0} blockiert`,
    regex: () => `${value.patterns?.length || 0} Muster · ${value.mode === 'any' ? 'eines' : 'alle'}`,
    parser: () => `${Math.round(Number(value.timeoutMs || 0) / 1000)} s · ${value.templateName}`,
    schema: () => trading?.signalSchemas.find(item => item.id === value.schemaId)?.name || String(value.schemaId),
    contract: () => String(value.contractVersionId),
    dedupe: () => value.enabled === false ? 'deaktiviert' : `${value.cooldownHours} h Cooldown`,
    strategy: () => trading?.strategies.find(item => item.id === value.strategyVersionId)?.name || String(value.strategyVersionId),
    sizing: () => `${value.riskPerTradePercent}% Basis · ${value.maxAdaptiveRiskPercent}% max · ${value.maxLeverage}×`,
    adaptive_risk: () => value.enabled === false ? 'deaktiviert' : `${value.mode} · ${value.tiers?.length || 0} Stufen`,
    output: () => ({
      telegram_xml: 'Telegram XML', telegram_original: 'Telegram Original',
      none: 'Keine Ausgabe', audit_only: 'Audit & Journal',
    })[String(value.mode)] || 'Audit & Journal',
  }
  return summaries[resource.kind]?.() || resource.name
}

function newId(prefix: string): string {
  return `${prefix}-${crypto.randomUUID()}`
}

function impactText(impact: any): string {
  const lines = [
    `${impact.changed?.length || 0} Pfad(e) werden geändert.`,
    `${impact.removed?.length || 0} Pfad(e) werden entfernt.`,
  ]
  for (const path of [...(impact.changed || []), ...(impact.removed || [])].slice(0, 10)) {
    lines.push(`• ${path.channelId} → ${path.accountId}`)
  }
  return `${lines.join('\n')}\n\nDiese Änderung sofort als aktive Revision übernehmen?`
}

export function confirmWorkflowImpact(impact: any): string | null {
  const required = typeof impact?.confirmation === 'string' ? impact.confirmation : ''
  if (!required) return null
  const entered = window.prompt(`${impactText(impact)}\n\nZur Bestätigung exakt eingeben:\n${required}`)
  return entered === required ? required : null
}

function workflowSnapshot(payload: any): WorkflowSnapshot {
  const resources = Array.isArray(payload?.resources) ? payload.resources : []
  const candidate = payload?.workflow
  const graph = candidate?.graph
  const compiled = candidate?.compiled
  const validWorkflow = candidate && graph && Array.isArray(graph.nodes) && Array.isArray(graph.edges)
    && compiled && Array.isArray(compiled.paths) && Array.isArray(compiled.warnings)
  return { workflow: validWorkflow ? candidate : null, resources }
}

function tradingSnapshot(payload: any): TradingSnapshot | null {
  const valid = payload?.overview?.runtime && Array.isArray(payload.accounts) && Array.isArray(payload.strategies)
    && Array.isArray(payload.signalSchemas) && Array.isArray(payload.signalContracts)
    && Array.isArray(payload.intents) && Array.isArray(payload?.activity?.positions)
    && Array.isArray(payload?.activity?.riskEvents) && Array.isArray(payload?.activity?.reconciliations)
  return valid ? payload : null
}

function exchangeCatalog(payload: any): ExchangeCatalog | null {
  return payload?.implementation && Array.isArray(payload.exchanges) ? payload : null
}

export function WorkflowBuilder() {
  const [snapshot, setSnapshot] = useState<WorkflowSnapshot>({ workflow: null, resources: [] })
  const [trading, setTrading] = useState<TradingSnapshot | null>(null)
  const [catalog, setCatalog] = useState<ExchangeCatalog | null>(null)
  const [systemStatus, setSystemStatus] = useState<Record<string, any> | null>(null)
  const [graph, setGraph] = useState<WorkflowGraph>(EMPTY_GRAPH)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [notice, setNotice] = useState<{ tone: 'ok' | 'warning' | 'error'; text: string } | null>(null)
  const [operationsOpen, setOperationsOpen] = useState(false)
  const [editorNodeId, setEditorNodeId] = useState<string | null>(null)
  const [newKind, setNewKind] = useState<WorkflowKind | null>(null)
  const [kindPickerOpen, setKindPickerOpen] = useState(false)
  const [libraryKind, setLibraryKind] = useState<WorkflowKind | null>(null)
  const [simulationOpen, setSimulationOpen] = useState(false)
  const [simulation, setSimulation] = useState({ channelId: '', contentType: 'text', text: '' })
  const [simulationResult, setSimulationResult] = useState<any>(null)
  const [search, setSearch] = useState('')
  const closeLibrary = useCallback(() => { setKindPickerOpen(false); setLibraryKind(null) }, [])
  const closeSimulation = useCallback(() => setSimulationOpen(false), [])
  const libraryDialogRef = useModalFocus<HTMLElement>(kindPickerOpen, closeLibrary)
  const simulationDialogRef = useModalFocus<HTMLElement>(simulationOpen, closeSimulation)
  const graphRef = useRef(graph)
  graphRef.current = graph

  const load = useCallback(async () => {
    const [workflowPayload, tradingPayload, statusPayload, catalogPayload] = await Promise.all([
      jsonRequest('/api/workflow'), jsonRequest('/api/trading'), jsonRequest('/api/status'), jsonRequest('/api/exchanges/catalog'),
    ])
    const nextSnapshot = workflowSnapshot(workflowPayload)
    setSnapshot(nextSnapshot)
    setTrading(tradingSnapshot(tradingPayload))
    setSystemStatus(statusPayload && typeof statusPayload === 'object' ? statusPayload : null)
    setCatalog(exchangeCatalog(catalogPayload))
    setGraph(structuredClone(nextSnapshot.workflow?.graph || EMPTY_GRAPH))
    setLoading(false)
  }, [])

  useEffect(() => { void load().catch(error => { setLoading(false); setNotice({ tone: 'error', text: error.message }) }) }, [load])

  useEffect(() => {
    const timer = window.setInterval(() => {
      void Promise.all([jsonRequest('/api/trading'), jsonRequest('/api/status')])
        .then(([tradingPayload, statusPayload]) => {
          setTrading(tradingSnapshot(tradingPayload))
          setSystemStatus(statusPayload && typeof statusPayload === 'object' ? statusPayload : null)
        })
        .catch(() => undefined)
    }, 5000)
    return () => window.clearInterval(timer)
  }, [])

  const resourceById = useMemo(() => new Map(snapshot.resources.map(resource => [resource.id, resource])), [snapshot.resources])
  const publishedLibrary = useMemo(() => {
    const latest = new Map<string, WorkflowResource>()
    for (const resource of snapshot.resources) {
      if (resource.status !== 'published') continue
      const current = latest.get(resource.resourceId)
      if (!current || current.version < resource.version) latest.set(resource.resourceId, resource)
    }
    return [...latest.values()].sort((left, right) => left.name.localeCompare(right.name, 'de-DE'))
  }, [snapshot.resources])
  const openEditor = useCallback((nodeId: string) => setEditorNodeId(nodeId), [])
  const executableNodeIds = useMemo(() => new Set(snapshot.workflow?.compiled.paths.filter(path => path.enabled).flatMap(path => path.nodeIds) || []), [snapshot.workflow])

  const displayNodes = useMemo<Node[]>(() => {
    const headers: Node[] = WORKFLOW_KINDS.map(kind => ({
      id: `__column_${kind}`, type: 'columnHeader', draggable: false, selectable: false,
      position: { x: KIND_META[kind].order * COLUMN_GAP, y: -185 }, data: { kind },
      initialWidth: COLUMN_HEADER_DIMENSIONS.width,
      initialHeight: COLUMN_HEADER_DIMENSIONS.height,
      style: { width: COLUMN_HEADER_DIMENSIONS.width, zIndex: -1 },
    }))
    const query = search.trim().toLocaleLowerCase('de-DE')
    const nodes: Node[] = graph.nodes.map(node => {
      const resource = resourceById.get(node.resourceVersionId)
      const warning = snapshot.workflow?.compiled.warnings.find(item => item.includes(node.id))
      const visible = !query || `${resource?.name || ''} ${KIND_META[node.kind].label} ${resource ? summary(resource, trading) : ''}`.toLocaleLowerCase('de-DE').includes(query)
      return {
        id: node.id,
        type: 'workflow',
        position: { x: KIND_META[node.kind].order * COLUMN_GAP, y: node.position.y },
        hidden: !visible,
        data: {
          kind: node.kind,
          name: resource?.name || 'Fehlende Ressource',
          summary: resource ? summary(resource, trading) : node.resourceVersionId,
          version: resource?.version || 0,
          enabled: executableNodeIds.has(node.id),
          warning,
          onEdit: openEditor,
        } satisfies WorkflowNodeData,
        initialWidth: WORKFLOW_NODE_DIMENSIONS.width,
        initialHeight: WORKFLOW_NODE_DIMENSIONS.height,
        handles: workflowHandles(node.kind),
        style: { width: WORKFLOW_NODE_DIMENSIONS.width },
      }
    })
    return [...headers, ...nodes]
  }, [executableNodeIds, graph.nodes, openEditor, resourceById, search, snapshot.workflow?.compiled.warnings, trading])

  const displayEdges = useMemo<Edge[]>(() => graph.edges.map(edge => ({
    ...edge, type: 'smoothstep', animated: false,
    style: { stroke: '#64748b', strokeWidth: 1.6 },
  })), [graph.edges])

  const activateGraph = useCallback(async (candidate: WorkflowGraph, successMessage: string) => {
    setSaving(true)
    setNotice(null)
    try {
      const impactPayload = await jsonRequest('/api/workflow/impact', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ baseRevisionId: snapshot.workflow?.id ?? null, graph: candidate }),
      })
      const impact = impactPayload.impact
      let confirmation: string | null = null
      if (impact.destructive) {
        confirmation = confirmWorkflowImpact(impact)
        if (!confirmation) return false
      }
      const payload = await jsonRequest('/api/workflow/mutate', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ baseRevisionId: snapshot.workflow?.id ?? null, graph: candidate, confirmation }),
      })
      setSnapshot(previous => ({ ...previous, workflow: payload.workflow }))
      setGraph(structuredClone(payload.workflow.graph))
      setNotice({ tone: impact.destructive ? 'warning' : 'ok', text: `${successMessage} · Revision ${payload.workflow.revision} ist aktiv.` })
      return true
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      setNotice({ tone: 'error', text: message === 'WORKFLOW_REVISION_CONFLICT' ? 'Der Workflow wurde parallel geändert. Der aktuelle Stand wird neu geladen.' : message })
      if (message.includes('WORKFLOW_REVISION_CONFLICT')) await load()
      return false
    } finally { setSaving(false) }
  }, [load, snapshot.workflow?.id])

  const onNodesChange = useCallback((changes: NodeChange[]) => {
    const relevant = changes.filter(change => !('id' in change) || !change.id.startsWith('__column_'))
    if (relevant.length === 0) return
    const currentNodes: Node[] = graphRef.current.nodes.map(node => ({ id: node.id, position: node.position, data: {} }))
    const updated = applyNodeChanges(relevant, currentNodes)
    const positions = new Map(updated.map(node => [node.id, node.position]))
    setGraph(previous => ({ ...previous, nodes: previous.nodes.map(node => ({ ...node, position: positions.get(node.id) || node.position })) }))
  }, [])

  const persistPosition: OnNodeDrag = useCallback((_event, node) => {
    if (node.id.startsWith('__column_')) return
    const candidate = structuredClone(graphRef.current)
    const target = candidate.nodes.find(item => item.id === node.id)
    if (!target) return
    target.position = { x: KIND_META[target.kind].order * COLUMN_GAP, y: Math.round(node.position.y / 10) * 10 }
    setGraph(candidate)
    void activateGraph(candidate, 'Position gespeichert')
  }, [activateGraph])

  const onConnect = useCallback((connection: Connection) => {
    const source = graphRef.current.nodes.find(node => node.id === connection.source)
    const target = graphRef.current.nodes.find(node => node.id === connection.target)
    if (!source || !target || KIND_META[source.kind].order >= KIND_META[target.kind].order) {
      setNotice({ tone: 'error', text: 'Verbindungen müssen von einer früheren in eine spätere Verarbeitungsspalte zeigen.' })
      return
    }
    if (graphRef.current.edges.some(edge => edge.source === source.id && edge.target === target.id)) return
    const candidate = structuredClone(graphRef.current)
    candidate.edges.push({ id: newId('edge'), source: source.id, target: target.id })
    void activateGraph(candidate, 'Verbindung aktiviert')
  }, [activateGraph])

  const onEdgesChange = useCallback((changes: EdgeChange[]) => {
    if (!changes.some(change => change.type === 'remove')) return
    const updated = applyEdgeChanges(changes, displayEdges)
    const candidate = { ...structuredClone(graphRef.current), edges: updated.map(edge => ({ id: edge.id, source: edge.source, target: edge.target })) }
    void activateGraph(candidate, 'Verbindung entfernt')
  }, [activateGraph, displayEdges])

  const selectedNode = editorNodeId ? graph.nodes.find(node => node.id === editorNodeId) || null : null
  const selectedResource = selectedNode ? resourceById.get(selectedNode.resourceVersionId) || null : null
  const editorKind = newKind || selectedNode?.kind || 'channel'

  const saveResource = async (value: { name: string; description: string; configuration: Record<string, unknown> }) => {
    const base = selectedResource
    const draftPayload = await jsonRequest('/api/workflow/resources', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ...(base ? { resourceId: base.resourceId } : {}), kind: editorKind,
        name: value.name, description: value.description, configuration: value.configuration,
      }),
    })
    const publishPayload = await jsonRequest('/api/workflow/resources/publish', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: draftPayload.resource.id }),
    })
    const resource = publishPayload.resource as WorkflowResource
    const candidate = structuredClone(graphRef.current)
    if (selectedNode) {
      const node = candidate.nodes.find(item => item.id === selectedNode.id)!
      node.resourceVersionId = resource.id
    } else {
      const sameColumn = candidate.nodes.filter(item => item.kind === editorKind)
      candidate.nodes.push({
        id: newId('node'), kind: editorKind, resourceVersionId: resource.id,
        position: { x: KIND_META[editorKind].order * COLUMN_GAP, y: sameColumn.length * 150 },
      })
    }
    const activated = await activateGraph(candidate, base ? `${value.name} aktualisiert` : `${value.name} hinzugefügt`)
    if (activated) setSnapshot(previous => ({ ...previous, resources: [...previous.resources, resource] }))
    else await load()
    return activated
  }

  const addExistingResource = async (resource: WorkflowResource) => {
    const candidate = structuredClone(graphRef.current)
    const sameColumn = candidate.nodes.filter(item => item.kind === resource.kind)
    candidate.nodes.push({
      id: newId('node'), kind: resource.kind, resourceVersionId: resource.id,
      position: { x: KIND_META[resource.kind].order * COLUMN_GAP, y: sameColumn.length * 150 },
    })
    const activated = await activateGraph(candidate, `${resource.name} wiederverwendet`)
    if (activated) {
      setKindPickerOpen(false)
      setLibraryKind(null)
    }
  }

  const deleteNode = async () => {
    if (!selectedNode) return
    const candidate = structuredClone(graphRef.current)
    candidate.nodes = candidate.nodes.filter(node => node.id !== selectedNode.id)
    candidate.edges = candidate.edges.filter(edge => edge.source !== selectedNode.id && edge.target !== selectedNode.id)
    const activated = await activateGraph(candidate, 'Baustein entfernt')
    if (activated) setEditorNodeId(null)
  }

  const configureAccount = async (accountId: string, maximum: number) => {
    await jsonRequest('/api/trading/accounts/configuration', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: accountId, maxConcurrentPositions: maximum }),
    })
    const refreshed = await jsonRequest('/api/trading')
    setTrading(tradingSnapshot(refreshed))
  }

  const runSimulation = async () => {
    try {
      const payload = await jsonRequest('/api/workflow/simulate', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(simulation),
      })
      setSimulationResult(payload.result)
    } catch (error) { setSimulationResult({ error: error instanceof Error ? error.message : String(error) }) }
  }

  if (loading) return <div className="builder-loading"><Workflow size={28} /><span>Lade aktive Workflow-Revision…</span></div>

  return <main className="workflow-shell" aria-label="TSX Core Workflow Builder">
    <header className="workflow-topbar">
      <div className="workflow-brand"><div className="workflow-mark"><Workflow size={21} /></div><div><span>TSX Core</span><strong>Execution Workflow</strong></div></div>
      <div className="workflow-health">
        <span className={`health-chip ${systemStatus?.connectionState === 'connected' ? 'healthy' : ''}`}><i />Telegram {systemStatus?.connectionState || 'offline'}</span>
        <span className={`health-chip ${trading?.overview.runtime.executionEnabled ? 'healthy' : ''}`}><i />Execution {trading?.overview.runtime.executionEnabled ? 'aktiv' : 'pausiert'}</span>
        <span className={`health-chip ${trading?.overview.runtime.killSwitchActive ? 'danger' : 'healthy'}`}><ShieldCheck size={14} />{trading?.overview.runtime.killSwitchActive ? 'global gesperrt' : 'Schutz bereit'}</span>
      </div>
      <div className="workflow-actions">
        <div className="builder-search"><Search size={15} /><input aria-label="Bausteine durchsuchen" placeholder="Baustein suchen" value={search} onChange={event => setSearch(event.target.value)} /></div>
        <button type="button" className="secondary-button" onClick={event => { event.currentTarget.focus(); setSimulationOpen(true) }}><FlaskConical size={15} /> Simulieren</button>
        <button type="button" className="secondary-button" onClick={event => { event.currentTarget.focus(); setOperationsOpen(true) }}><Activity size={15} /> Betrieb</button>
        <button type="button" className="primary-button" onClick={event => { event.currentTarget.focus(); setLibraryKind(null); setKindPickerOpen(true) }}><Plus size={16} /> Baustein</button>
      </div>
    </header>
      <section className="workflow-statusbar" aria-label="Workflow-Status">
      <a className="workflow-status-skip" href="#workflow-canvas">Statusleiste überspringen</a>
      <div><strong>Revision {snapshot.workflow?.revision ?? 0}</strong><span>{snapshot.workflow ? `aktiv seit ${new Date(snapshot.workflow.createdAt).toLocaleString('de-DE')}` : 'Noch keine aktive Revision'}</span></div>
      <div><strong>{snapshot.workflow?.compiled.paths.length ?? 0} Pfade</strong><span>{snapshot.workflow?.compiled.paths.filter(path => path.enabled).length ?? 0} ausführbar</span></div>
      <div><strong>{graph.nodes.length} Bausteine</strong><span>{graph.edges.length} Verbindungen</span></div>
      <div className="save-indicator">{saving ? <><RefreshCw size={14} className="spin" /> validiere & aktiviere</> : <><Save size={14} /> alle Änderungen gespeichert</>}</div>
    </section>
    {notice && <div className={`builder-notice ${notice.tone}`}><span>{notice.tone === 'ok' ? <Check size={16} /> : <AlertTriangle size={16} />}</span><p>{notice.text}</p><button type="button" onClick={() => setNotice(null)}><X size={14} /></button></div>}
    <div id="workflow-canvas" className="workflow-canvas">
      <ReactFlow
        nodes={displayNodes}
        edges={displayEdges}
        nodeTypes={nodeTypes}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        onConnect={onConnect}
        onNodeDragStop={persistPosition}
        onNodeClick={((_event, node) => !node.id.startsWith('__column_') && setEditorNodeId(node.id)) as NodeMouseHandler}
        deleteKeyCode={null}
        minZoom={0.18}
        maxZoom={1.5}
        defaultViewport={{ x: 24, y: 210, zoom: 0.88 }}
        proOptions={{ hideAttribution: true }}
        defaultEdgeOptions={{ type: 'smoothstep' }}
      >
        <Background variant={BackgroundVariant.Dots} gap={24} size={1} color="rgba(148,163,184,.16)" />
        <Controls position="bottom-left" showInteractive={false} />
        <MiniMap position="bottom-right" pannable zoomable nodeColor={node => node.id.startsWith('__column_') ? 'transparent' : KIND_META[(node.data as any).kind]?.color || '#64748b'} maskColor="rgba(2,6,23,.72)" />
      </ReactFlow>
    </div>

    <ResourceEditor
      open={Boolean(editorNodeId || newKind)} kind={editorKind} resource={selectedResource}
      trading={trading} onClose={() => { setEditorNodeId(null); setNewKind(null) }}
      onSave={saveResource} onDeleteNode={selectedNode ? deleteNode : undefined}
      onConfigureAccount={configureAccount}
    />
    {kindPickerOpen && <div className="builder-modal-backdrop"><section ref={libraryDialogRef} className="kind-picker" role="dialog" aria-modal="true" aria-labelledby="workflow-library-title" tabIndex={-1}><header><div><span>Baustein-Bibliothek</span><h2 id="workflow-library-title">{libraryKind ? KIND_META[libraryKind].label : 'Was soll der Workflow als Nächstes können?'}</h2></div><button type="button" className="icon-button" onClick={closeLibrary} aria-label="Baustein-Bibliothek schließen"><X size={18} /></button></header>{!libraryKind ? <div>{WORKFLOW_KINDS.map(kind => { const available = publishedLibrary.filter(resource => resource.kind === kind).length; return <button type="button" key={kind} style={{ '--node-accent': KIND_META[kind].color } as CSSProperties} onClick={() => setLibraryKind(kind)}><i /><strong>{KIND_META[kind].label}</strong><span>{available ? `${available} veröffentlichte Bausteine` : 'Noch kein gespeicherter Baustein'}</span></button> })}</div> : <div className="resource-library"><button type="button" className="library-back" onClick={() => setLibraryKind(null)}>← Alle Bausteinarten</button><button type="button" className="library-new" style={{ '--node-accent': KIND_META[libraryKind].color } as CSSProperties} onClick={() => { setKindPickerOpen(false); setNewKind(libraryKind); setLibraryKind(null) }}><Plus size={16} /><strong>Neuen Baustein erstellen</strong><span>Mit einer neuen unveränderlichen Version beginnen</span></button>{publishedLibrary.filter(resource => resource.kind === libraryKind).map(resource => <button type="button" key={resource.id} className="library-existing" style={{ '--node-accent': KIND_META[libraryKind].color } as CSSProperties} onClick={() => void addExistingResource(resource)}><i /><strong>{resource.name}</strong><span>Version {resource.version}{resource.description ? ` · ${resource.description}` : ''}</span></button>)}</div>}</section></div>}
    {simulationOpen && <div className="builder-modal-backdrop"><section ref={simulationDialogRef} className="simulation-modal" role="dialog" aria-modal="true" aria-labelledby="workflow-simulation-title" tabIndex={-1}><header><div><span>Trockenlauf</span><h2 id="workflow-simulation-title">Signal durch aktive Revision schicken</h2></div><button type="button" className="icon-button" onClick={closeSimulation} aria-label="Simulation schließen"><X size={18} /></button></header><label>Kanal-ID<input value={simulation.channelId} onChange={event => setSimulation({ ...simulation, channelId: event.target.value })} /></label><label>Inhaltstyp<select value={simulation.contentType} onChange={event => setSimulation({ ...simulation, contentType: event.target.value })}><option value="text">Text</option><option value="photo">Foto mit Caption</option><option value="video">Video mit Caption</option><option value="document">Dokument</option></select></label><label>Beispielnachricht<textarea value={simulation.text} onChange={event => setSimulation({ ...simulation, text: event.target.value })} /></label><button type="button" className="primary-button" onClick={runSimulation}><FlaskConical size={15} /> Pfade prüfen</button>{simulationResult && <div className="simulation-result" aria-live="polite">{simulationResult.error ? <div className="builder-error" role="alert">{simulationResult.error}</div> : <>{simulationResult.paths?.map((path: any) => <div key={path.id} className={path.allowed && path.enabled ? 'pass' : 'blocked'}><span>{path.allowed && path.enabled ? 'PASS' : 'BLOCK'}</span><strong>{path.accountId}</strong><small>{path.reason || (path.enabled ? 'Filter erfüllt' : 'Konto nicht bereit')}</small></div>)}{simulationResult.paths?.length === 0 && <EmptySimulation />}</>}</div>}</section></div>}
    <OperationsPanel open={operationsOpen} trading={trading} catalog={catalog} systemStatus={systemStatus} onClose={() => setOperationsOpen(false)} onRefresh={load} />
  </main>
}

function EmptySimulation() { return <div className="operations-empty">Für diesen Kanal existiert kein vollständiger Pfad.</div> }

import { Handle, Position, type NodeProps } from '@xyflow/react'
import type { CSSProperties } from 'react'
import {
  Bot, Braces, CircleDollarSign, CopyCheck, FileCheck2, Filter, Landmark,
  MessageCircle, Route, ShieldCheck, SlidersHorizontal, TextSearch, Webhook,
} from 'lucide-react'
import { KIND_META, type WorkflowKind } from './types'

const ICONS = {
  channel: MessageCircle,
  content_filter: Filter,
  keyword_filter: TextSearch,
  regex: Braces,
  parser: Bot,
  schema: FileCheck2,
  contract: ShieldCheck,
  dedupe: CopyCheck,
  strategy: SlidersHorizontal,
  sizing: CircleDollarSign,
  adaptive_risk: Route,
  account: Landmark,
  output: Webhook,
} satisfies Record<WorkflowKind, typeof MessageCircle>

export type WorkflowNodeData = {
  kind: WorkflowKind
  name: string
  summary: string
  version: number
  enabled: boolean
  warning?: string
  onEdit: (nodeId: string) => void
}

export function WorkflowNode({ id, data, selected }: NodeProps) {
  const node = data as WorkflowNodeData
  const meta = KIND_META[node.kind]
  const Icon = ICONS[node.kind]
  return (
    <button
      type="button"
      className={`workflow-node ${selected ? 'is-selected' : ''} ${node.enabled ? '' : 'is-inert'}`}
      style={{ '--node-accent': meta.color } as CSSProperties}
      onDoubleClick={(event) => {
        event.stopPropagation()
        node.onEdit(id)
      }}
      aria-label={`${meta.label} ${node.name} bearbeiten`}
    >
      {node.kind !== 'channel' && <Handle type="target" position={Position.Left} className="workflow-handle" />}
      <span className="workflow-node-icon"><Icon size={17} strokeWidth={1.8} /></span>
      <span className="workflow-node-body">
        <span className="workflow-node-eyebrow">{meta.label}</span>
        <span className="workflow-node-title">{node.name}</span>
        <span className="workflow-node-summary">{node.summary}</span>
      </span>
      <span className="workflow-node-version">v{node.version}</span>
      {node.warning && <span className="workflow-node-warning" title={node.warning}>!</span>}
      {node.kind !== 'output' && <Handle type="source" position={Position.Right} className="workflow-handle" />}
    </button>
  )
}

export function ColumnHeaderNode({ data }: NodeProps) {
  const node = data as { kind: WorkflowKind }
  const meta = KIND_META[node.kind]
  return (
    <div className="workflow-column-header" style={{ '--node-accent': meta.color } as CSSProperties}>
      <span>{String(meta.order + 1).padStart(2, '0')}</span>
      <strong>{meta.short}</strong>
    </div>
  )
}

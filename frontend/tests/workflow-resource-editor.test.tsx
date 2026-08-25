import '@testing-library/jest-dom/vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const api = vi.hoisted(() => ({ apiFetch: vi.fn() }))
vi.mock('@/lib/api', () => api)

import { defaultConfiguration, ResourceEditor } from '@/app/workflow/resource-editor'
import { KIND_META, WORKFLOW_KINDS } from '@/app/workflow/types'

const trading = {
  accounts: [{ id: 'account-1', name: 'Paper', exchange: 'paper', mode: 'paper', status: 'ready', enabled: true, maxConcurrentPositions: 7, killSwitchActive: false, killSwitchReason: null, lastReconciledAt: null, lastError: null }],
  strategies: [{
    id: 'strategy-v1', strategyId: 'strategy', version: 1, name: 'VIP Strategy', description: 'stable', status: 'published',
    configuration: {
      schemaVersion: 3,
      allowedSignalSchemas: ['standard'],
      allowedSymbols: [],
      allowedSides: ['LONG', 'SHORT'],
      entry: { orderType: 'limit', rangePrice: 'midpoint', postOnly: false, timeoutSeconds: 10 },
      sizing: { positionSizingMode: 'equity_percent_margin', riskPerTradePercent: '5', maxAdaptiveRiskPercent: '10', maxPositionNotional: '1000000000', maxLeverage: 50 },
      exits: { targetAllocationMode: 'manual', targetAllocationsPercent: ['50', '50'], stopLossMode: 'configured', moveStopToBreakEvenAfterTarget: 1, trailingStopPercent: null, closeRemainderAtLastTarget: true },
      safety: { maxDailyLossMode: 'equity_percent', maxDailyLoss: '5', maxSlippagePercent: '0.5', entryOrderTtlSeconds: 900, requireProtectiveStop: true },
    },
  }],
  signalSchemas: [{ id: 'standard', name: 'Standard', description: 'schema', parserSchema: 'standard', enabled: true, contractVersionId: 'standard:v1', templateName: 'default' }],
  signalContracts: [{ id: 'standard', name: 'Standard Contract', description: 'contract', versions: [{
    id: 'standard:v1', contractId: 'standard', version: 1, status: 'published',
    definition: {
      schemaVersion: 1,
      rootTag: 'signal',
      actionPath: 'action',
      pairPath: 'pair',
      entry: { mode: 'optional_range', marketValues: ['market'], rangeValues: ['range'], minimumPath: 'entry/min', maximumPath: 'entry/max' },
      targets: { containerPath: 'targets', itemTag: 'target', shape: 'range', minimumPath: 'min', maximumPath: 'max', minimumItems: 1, maximumItems: 20, sequentialIds: true },
      stopLossPath: 'stopLoss',
      leveragePath: 'leverage',
      riskPercentPath: 'riskPercent',
      averagingPricePath: 'averagingPrice',
      additionalFields: [],
      geometry: { stopOnLossSide: true, targetsOnProfitSide: true, orderedTargets: true, orderedRanges: true },
      grounding: { action: true, pair: true, entry: true, targets: true, stopLoss: true, leverage: false, riskPercent: false, averagingPrice: false },
    },
  }] }],
} as any

function response(body: unknown, status = 200) {
  return Promise.resolve(new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } }))
}

function editor(kind: any, onSave = vi.fn(async () => true)) {
  render(<ResourceEditor open kind={kind} resource={null} trading={trading} onClose={vi.fn()} onSave={onSave} />)
  return onSave
}

describe('workflow resource contracts', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    api.apiFetch.mockImplementation((url: string) => url === '/api/templates' ? response({ templates: { default: 'BASE PROMPT' } }) : response({ success: true, result: {} }))
  })
  afterEach(() => cleanup())

  it('keeps every processing kind in a strict left-to-right column order', () => {
    expect(WORKFLOW_KINDS.map(kind => KIND_META[kind].order)).toEqual(WORKFLOW_KINDS.map((_, index) => index))
  })

  it('defaults parsers to two minutes and database-only signal storage', () => {
    expect(defaultConfiguration('parser', trading)).toMatchObject({ timeoutMs: 120_000, saveToFile: false })
  })

  it('defaults sizing to margin capital and account capacity to the concrete account', () => {
    expect(defaultConfiguration('sizing', trading)).toMatchObject({ positionSizingMode: 'equity_percent_margin', riskPerTradePercent: '5', maxLeverage: 50 })
    expect(defaultConfiguration('account', trading)).toEqual({ accountId: 'account-1' })
  })

  it('saves a channel resource through its popup', async () => {
    const onSave = editor('channel')
    fireEvent.change(screen.getByLabelText(/Telegram-Kanal-ID/), { target: { value: '-100123' } })
    fireEvent.click(screen.getByRole('button', { name: 'Version speichern & aktivieren' }))
    await waitFor(() => expect(onSave).toHaveBeenCalledWith(expect.objectContaining({ configuration: { channelId: '-100123' } })))
  })

  it('persists parser prompts while forcibly keeping file storage disabled', async () => {
    const onSave = editor('parser')
    await waitFor(() => expect(screen.getByLabelText(/Parser-Prompt/)).toHaveValue('BASE PROMPT'))
    fireEvent.change(screen.getByLabelText(/Parser-Prompt/), { target: { value: 'UPDATED PROMPT' } })
    fireEvent.click(screen.getByRole('button', { name: 'Version speichern & aktivieren' }))
    await waitFor(() => expect(onSave).toHaveBeenCalledWith(expect.objectContaining({
      configuration: expect.objectContaining({ saveToFile: false, timeoutMs: 120_000, prompt: 'UPDATED PROMPT' }),
    })))
    expect(api.apiFetch).not.toHaveBeenCalledWith('/api/templates', expect.objectContaining({ method: 'POST' }))
  })

  it('publishes a new strategy version instead of mutating the selected version', async () => {
    api.apiFetch.mockImplementation((url: string) => {
      if (url === '/api/trading/strategies') return response({ result: { id: 'strategy-v2' } }, 201)
      if (url === '/api/trading/strategies/publish') return response({ result: { id: 'strategy-v2' } })
      return response({ templates: { default: 'BASE PROMPT' } })
    })
    const onSave = editor('strategy')
    fireEvent.change(screen.getByLabelText('Max. Slippage (%)'), { target: { value: '0.75' } })
    fireEvent.click(screen.getByRole('button', { name: 'Version speichern & aktivieren' }))
    await waitFor(() => expect(onSave).toHaveBeenCalledWith(expect.objectContaining({ configuration: { strategyVersionId: 'strategy-v2' } })))
    expect(api.apiFetch).toHaveBeenCalledWith('/api/trading/strategies', expect.objectContaining({
      method: 'POST',
      body: expect.stringContaining('"maxSlippagePercent":"0.75"'),
    }))
    expect(screen.queryByLabelText(/Strategiedefinition/)).not.toBeInTheDocument()
  })

  it('publishes a new independent contract version from the contract popup', async () => {
    api.apiFetch.mockImplementation((url: string) => {
      if (url.endsWith('/versions')) return response({ result: { id: 'standard:v2' } }, 201)
      if (url.endsWith('/publish')) return response({ result: { id: 'standard:v2' } })
      return response({ result: { id: 'standard:v2' } })
    })
    const onSave = editor('contract')
    fireEvent.change(screen.getByLabelText('Maximal Targets'), { target: { value: '10' } })
    fireEvent.click(screen.getByRole('button', { name: 'Version speichern & aktivieren' }))
    await waitFor(() => expect(onSave).toHaveBeenCalledWith(expect.objectContaining({ configuration: { contractVersionId: 'standard:v2' } })))
    expect(api.apiFetch).toHaveBeenCalledWith('/api/trading/signal-contracts/update', expect.objectContaining({
      body: expect.stringContaining('"maximumItems":10'),
    }))
    expect(screen.queryByLabelText(/Vertragsdefinition/)).not.toBeInTheDocument()
  })

  it('shows used schemas read-only and creates an explicit immutable copy', async () => {
    api.apiFetch.mockImplementation((url: string) => {
      if (url === '/api/trading/signal-schemas') return response({ result: { id: 'standard-copy' } }, 201)
      if (url === '/api/templates') return response({ templates: { default: 'BASE PROMPT' } })
      return response({ success: true, result: {} })
    })
    const onSave = editor('schema')
    expect(screen.getByText('Fallback-Vertrag')).toBeInTheDocument()
    expect(screen.queryByLabelText('Schema-Name')).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Als neues Schema duplizieren' }))
    await waitFor(() => expect(screen.getByLabelText('Neue Schema-ID')).toHaveValue('standard-copy'))
    fireEvent.change(screen.getByLabelText('Schema-Name'), { target: { value: 'Standard Copy' } })
    fireEvent.click(screen.getByRole('button', { name: 'Version speichern & aktivieren' }))
    await waitFor(() => expect(onSave).toHaveBeenCalledWith(expect.objectContaining({
      configuration: { schemaId: 'standard-copy' },
    })))
    expect(api.apiFetch).toHaveBeenCalledWith('/api/trading/signal-schemas', expect.objectContaining({
      method: 'POST',
      body: expect.stringContaining('"name":"Standard Copy"'),
    }))
  })

  it('separates canvas removal from permanent library archival', async () => {
    const onDeleteNode = vi.fn(async () => undefined)
    const onArchiveResource = vi.fn(async () => undefined)
    render(
      <ResourceEditor
        open
        kind="channel"
        resource={{
          id: 'channel-v1', resourceId: 'channel', version: 1, kind: 'channel', name: 'My channel', description: '',
          status: 'published', configuration: { channelId: '-1001' }, configurationSha256: 'a'.repeat(64), createdAt: 1, publishedAt: 1,
        }}
        trading={trading}
        onClose={vi.fn()}
        onSave={vi.fn(async () => true)}
        onDeleteNode={onDeleteNode}
        onArchiveResource={onArchiveResource}
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: 'Nur vom Canvas lösen' }))
    expect(onDeleteNode).toHaveBeenCalledOnce()
    expect(onArchiveResource).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'Dauerhaft archivieren' }))
    expect(screen.getByText(/dauerhaft aus der Bibliothek archivieren/)).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Ja, dauerhaft archivieren' }))
    await waitFor(() => expect(onArchiveResource).toHaveBeenCalledOnce())
  })
})

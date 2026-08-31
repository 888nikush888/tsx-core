import '@testing-library/jest-dom/vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const api = vi.hoisted(() => {
  const apiFetch = vi.fn()
  const jsonRequest = vi.fn(async (url: string, init?: RequestInit) => {
    const response = await apiFetch(url, init)
    const payload = await response.json().catch(() => ({}))
    if (!response.ok) throw new Error(payload.error || `Anfrage fehlgeschlagen (${response.status}).`)
    return payload
  })
  return { apiFetch, jsonRequest }
})
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

function editor(
  kind: any,
  onSave = vi.fn(async () => true),
  snapshot: any = trading,
) {
  render(<ResourceEditor open kind={kind} resource={null} trading={snapshot} onClose={vi.fn()} onSave={onSave} />)
  return onSave
}

describe('workflow resource contracts', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    api.apiFetch.mockImplementation(() => response({ success: true, result: {} }))
  })
  afterEach(() => cleanup())

  it('keeps every processing kind in a strict left-to-right column order', () => {
    expect(WORKFLOW_KINDS.map(kind => KIND_META[kind].order)).toEqual(WORKFLOW_KINDS.map((_, index) => index))
  })

  it('defaults parsers to two minutes and database-only signal storage', () => {
    expect(defaultConfiguration('parser', trading)).toMatchObject({ timeoutMs: 120_000, saveToFile: false })
  })

  it('defaults sizing to margin capital and account capacity to the concrete account', () => {
    expect(defaultConfiguration('sizing', trading)).toMatchObject({
      positionSizingMode: 'equity_percent_margin', riskPerTradePercent: '5', defaultLeverage: 50, maxLeverage: 50,
    })
    expect(defaultConfiguration('account', trading)).toEqual({ accountId: 'account-1' })
  })

  it('saves a channel resource through its popup', async () => {
    const onSave = editor('channel')
    fireEvent.change(screen.getByLabelText(/Telegram-Kanal-ID/), { target: { value: '-100123' } })
    fireEvent.click(screen.getByRole('button', { name: 'Version speichern & aktivieren' }))
    await waitFor(() => expect(onSave).toHaveBeenCalledWith(expect.objectContaining({ configuration: { channelId: '-100123' } })))
  })

  it('stores the prompt directly in the parser block without global prompt templates', async () => {
    const onSave = editor('parser')
    expect(screen.queryByText('Prompt-Vorlage')).not.toBeInTheDocument()
    expect(screen.getByLabelText(/Parser-Prompt/)).toHaveValue('')
    fireEvent.change(screen.getByLabelText(/Parser-Prompt/), { target: { value: 'UPDATED PROMPT' } })
    fireEvent.click(screen.getByRole('button', { name: 'Version speichern & aktivieren' }))
    await waitFor(() => expect(onSave).toHaveBeenCalledWith(expect.objectContaining({
      configuration: expect.objectContaining({
        templateName: 'inline', saveToFile: false, timeoutMs: 120_000, prompt: 'UPDATED PROMPT',
      }),
    })))
    expect(api.apiFetch).not.toHaveBeenCalledWith('/api/templates', expect.anything())
    expect(api.apiFetch).not.toHaveBeenCalledWith('/api/templates')
  })

  it('builds and publishes a new strategy inside an empty strategy block', async () => {
    api.apiFetch.mockImplementation((url: string) => {
      if (url === '/api/trading/strategies') return response({ result: { id: 'new-strategy-v1' } }, 201)
      if (url === '/api/trading/strategies/publish') return response({ result: { id: 'new-strategy-v1' } })
      return response({ success: true, result: {} })
    })
    const onSave = editor('strategy', undefined, { ...trading, strategies: [] })
    expect(screen.queryByLabelText('Veröffentlichte Strategie')).not.toBeInTheDocument()
    expect(screen.getByLabelText(/Standard-Hebel/)).toHaveValue(3)
    fireEvent.change(screen.getByLabelText(/Maximaler Hebel/), { target: { value: '5' } })
    fireEvent.change(screen.getByLabelText(/Standard-Hebel/), { target: { value: '5' } })
    fireEvent.click(screen.getByRole('button', { name: 'Version speichern & aktivieren' }))
    await waitFor(() => expect(onSave).toHaveBeenCalledWith(expect.objectContaining({
      configuration: { strategyVersionId: 'new-strategy-v1' },
    })))
    const request = api.apiFetch.mock.calls.find(([url]) => url === '/api/trading/strategies')?.[1] as RequestInit
    const submitted = JSON.parse(String(request.body))
    expect(submitted).not.toHaveProperty('strategyId')
    expect(submitted.configuration).toMatchObject({
      allowedSignalSchemas: ['standard'],
      sizing: { defaultLeverage: 5, maxLeverage: 3 },
    })
  })

  it('publishes a new strategy version instead of mutating the selected version', async () => {
    api.apiFetch.mockImplementation((url: string) => {
      if (url === '/api/trading/strategies') return response({ result: { id: 'strategy-v2' } }, 201)
      if (url === '/api/trading/strategies/publish') return response({ result: { id: 'strategy-v2' } })
      return response({ success: true, result: {} })
    })
    const onSave = editor('strategy')
    expect(screen.getByLabelText(/Standard-Hebel/)).toHaveValue(50)
    fireEvent.change(screen.getByLabelText(/Standard-Hebel/), { target: { value: '7' } })
    fireEvent.change(screen.getByLabelText('Max. Slippage (%)'), { target: { value: '0.75' } })
    fireEvent.click(screen.getByRole('button', { name: 'Version speichern & aktivieren' }))
    await waitFor(() => expect(onSave).toHaveBeenCalledWith(expect.objectContaining({ configuration: { strategyVersionId: 'strategy-v2' } })))
    const strategyRequest = api.apiFetch.mock.calls.find(([url]) => url === '/api/trading/strategies')?.[1] as RequestInit
    const submitted = JSON.parse(String(strategyRequest.body))
    expect(submitted.configuration).toMatchObject({
      schemaVersion: 4,
      sizing: { defaultLeverage: 7, maxLeverage: 50 },
      safety: { maxSlippagePercent: '0.75' },
    })
    expect(screen.queryByLabelText(/Strategiedefinition/)).not.toBeInTheDocument()
  })

  it('blocks invalid default leverage in both sizing editors before save', async () => {
    const sizingSave = editor('sizing')
    fireEvent.change(screen.getByLabelText(/Standard-Hebel/), { target: { value: '20' } })
    fireEvent.change(screen.getByLabelText(/Maximaler Hebel/), { target: { value: '10' } })
    fireEvent.click(screen.getByRole('button', { name: 'Version speichern & aktivieren' }))
    expect(await screen.findByText(/Standard-Hebel darf den maximalen Hebel nicht überschreiten/)).toBeVisible()
    expect(sizingSave).not.toHaveBeenCalled()
    cleanup()

    const strategySave = editor('strategy')
    fireEvent.change(screen.getByLabelText(/Standard-Hebel/), { target: { value: '20' } })
    fireEvent.change(screen.getByLabelText(/Maximaler Hebel/), { target: { value: '10' } })
    fireEvent.click(screen.getByRole('button', { name: 'Version speichern & aktivieren' }))
    expect(await screen.findByText(/Standard-Hebel darf den maximalen Hebel nicht überschreiten/)).toBeVisible()
    expect(strategySave).not.toHaveBeenCalled()
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

  it('builds and publishes a new signal contract inside an empty contract block', async () => {
    api.apiFetch.mockImplementation((url: string) => {
      if (url === '/api/trading/signal-contracts') {
        return response({ result: { id: 'fresh-contract', versions: [{ id: 'fresh-contract:v1' }] } }, 201)
      }
      if (url === '/api/trading/signal-contracts/publish') {
        return response({ result: { id: 'fresh-contract:v1' } })
      }
      return response({ success: true, result: {} })
    })
    const onSave = editor('contract', undefined, { ...trading, signalContracts: [] })
    expect(screen.queryByLabelText('Veröffentlichte Vertragsversion')).not.toBeInTheDocument()
    expect(screen.getByLabelText('Vertrags-ID')).toHaveValue('new-contract')
    expect(screen.getByLabelText('Maximal Targets')).toHaveValue(20)
    fireEvent.change(screen.getByLabelText('Vertrags-ID'), { target: { value: 'fresh-contract' } })
    fireEvent.change(screen.getByLabelText('Maximal Targets'), { target: { value: '8' } })
    fireEvent.click(screen.getByRole('button', { name: 'Version speichern & aktivieren' }))
    await waitFor(() => expect(onSave).toHaveBeenCalledWith(expect.objectContaining({
      configuration: { contractVersionId: 'fresh-contract:v1' },
    })))
    expect(api.apiFetch).toHaveBeenCalledWith('/api/trading/signal-contracts', expect.objectContaining({
      method: 'POST',
      body: expect.stringContaining('"maximumItems":8'),
    }))
  })

  it('builds a new signal schema inside an empty schema block', async () => {
    api.apiFetch.mockImplementation((url: string) => {
      if (url === '/api/trading/signal-schemas') return response({ result: { id: 'fresh-schema' } }, 201)
      return response({ success: true, result: {} })
    })
    const onSave = editor('schema', undefined, { ...trading, signalSchemas: [] })
    expect(screen.queryByLabelText('Verwendetes Signal-Schema')).not.toBeInTheDocument()
    expect(screen.queryByText('Prompt-Vorlage')).not.toBeInTheDocument()
    expect(screen.getByLabelText('Schema-ID')).toHaveValue('new-schema')
    expect(screen.getByLabelText('Parser-Schema')).toHaveValue('standard')
    fireEvent.change(screen.getByLabelText('Schema-ID'), { target: { value: 'fresh-schema' } })
    fireEvent.change(screen.getByLabelText('Schema-Name'), { target: { value: 'Fresh Schema' } })
    fireEvent.click(screen.getByRole('button', { name: 'Version speichern & aktivieren' }))
    await waitFor(() => expect(onSave).toHaveBeenCalledWith(expect.objectContaining({
      configuration: { schemaId: 'fresh-schema' },
    })))
    expect(api.apiFetch).toHaveBeenCalledWith('/api/trading/signal-schemas', expect.objectContaining({
      method: 'POST',
      body: expect.stringContaining('"parserSchema":"standard"'),
    }))
    const request = api.apiFetch.mock.calls.find(([url]) => url === '/api/trading/signal-schemas')?.[1] as RequestInit
    expect(JSON.parse(String(request.body))).toMatchObject({
      id: 'fresh-schema', name: 'Fresh Schema', templateName: 'fresh-schema', enabled: true,
    })
  })

  it('edits an existing schema directly while persisting an immutable copy', async () => {
    api.apiFetch.mockImplementation((url: string) => {
      if (url === '/api/trading/signal-schemas') return response({ result: { id: 'standard-copy' } }, 201)
      return response({ success: true, result: {} })
    })
    const onSave = editor('schema')
    expect(screen.getByLabelText('Schema-Name')).toHaveValue('Standard')
    fireEvent.change(screen.getByLabelText('Schema-Name'), { target: { value: 'Standard Copy' } })
    await waitFor(() => expect(screen.getByLabelText('Neue Schema-ID')).toHaveValue('standard-copy'))
    fireEvent.click(screen.getByRole('button', { name: 'Version speichern & aktivieren' }))
    await waitFor(() => expect(onSave).toHaveBeenCalledWith(expect.objectContaining({
      configuration: { schemaId: 'standard-copy' },
    })))
    expect(api.apiFetch).toHaveBeenCalledWith('/api/trading/signal-schemas', expect.objectContaining({
      method: 'POST',
      body: expect.stringContaining('"name":"Standard Copy"'),
    }))
  })

  it('separates canvas removal, archival and permanent deletion', async () => {
    const onDeleteNode = vi.fn(async () => undefined)
    const onArchiveResource = vi.fn(async () => undefined)
    const onDeleteResource = vi.fn(async () => undefined)
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
        onDeleteResource={onDeleteResource}
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: 'Nur vom Canvas lösen' }))
    expect(onDeleteNode).toHaveBeenCalledOnce()
    expect(onArchiveResource).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'Dauerhaft archivieren' }))
    expect(screen.getByText(/dauerhaft aus der Bibliothek archivieren/)).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Ja, dauerhaft archivieren' }))
    await waitFor(() => expect(onArchiveResource).toHaveBeenCalledOnce())
    expect(onDeleteResource).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'Endgültig löschen' }))
    expect(screen.getByText(/unwiderruflich aus der Bibliothek löschen/)).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Ja, endgültig löschen' }))
    await waitFor(() => expect(onDeleteResource).toHaveBeenCalledOnce())
  })
})

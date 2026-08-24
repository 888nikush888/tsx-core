import '@testing-library/jest-dom/vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const api = vi.hoisted(() => ({ apiFetch: vi.fn() }))
vi.mock('@/lib/api', () => api)

import { defaultConfiguration, ResourceEditor } from '@/app/workflow/resource-editor'
import { KIND_META, WORKFLOW_KINDS } from '@/app/workflow/types'

const trading = {
  accounts: [{ id: 'account-1', name: 'Paper', exchange: 'paper', mode: 'paper', status: 'ready', enabled: true, maxConcurrentPositions: 7, killSwitchActive: false, killSwitchReason: null, lastReconciledAt: null, lastError: null }],
  strategies: [{ id: 'strategy-v1', strategyId: 'strategy', version: 1, name: 'VIP Strategy', description: 'stable', status: 'published', configuration: { schemaVersion: 3, allowedSignalSchemas: ['standard'] } }],
  signalSchemas: [{ id: 'standard', name: 'Standard', description: 'schema', parserSchema: 'standard', enabled: true, contractVersionId: 'standard:v1', templateName: 'default' }],
  signalContracts: [{ id: 'standard', name: 'Standard Contract', description: 'contract', versions: [{ id: 'standard:v1', contractId: 'standard', version: 1, status: 'published', definition: { schemaVersion: 1, rootTag: 'signal' } }] }],
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
    fireEvent.change(screen.getByLabelText(/Strategiedefinition/), { target: { value: JSON.stringify({ schemaVersion: 3, allowedSignalSchemas: ['standard'], changed: true }) } })
    fireEvent.click(screen.getByRole('button', { name: 'Version speichern & aktivieren' }))
    await waitFor(() => expect(onSave).toHaveBeenCalledWith(expect.objectContaining({ configuration: { strategyVersionId: 'strategy-v2' } })))
  })

  it('publishes a new independent contract version from the contract popup', async () => {
    api.apiFetch.mockImplementation((url: string) => {
      if (url.endsWith('/versions')) return response({ result: { id: 'standard:v2' } }, 201)
      if (url.endsWith('/publish')) return response({ result: { id: 'standard:v2' } })
      return response({ result: { id: 'standard:v2' } })
    })
    const onSave = editor('contract')
    fireEvent.change(screen.getByLabelText(/Vertragsdefinition/), { target: { value: JSON.stringify({ schemaVersion: 1, rootTag: 'signal', changed: true }) } })
    fireEvent.click(screen.getByRole('button', { name: 'Version speichern & aktivieren' }))
    await waitFor(() => expect(onSave).toHaveBeenCalledWith(expect.objectContaining({ configuration: { contractVersionId: 'standard:v2' } })))
  })

  it('refuses to mutate a used schema under its existing identity', async () => {
    editor('schema')
    fireEvent.change(screen.getByLabelText('Schema-Name'), { target: { value: 'Changed in place' } })
    fireEvent.click(screen.getByRole('button', { name: 'Version speichern & aktivieren' }))
    await waitFor(() => expect(screen.getByText(/benötigen eine neue eindeutige Schema-ID/)).toBeInTheDocument())
  })
})

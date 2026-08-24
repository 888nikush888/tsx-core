import '@testing-library/jest-dom/vitest'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import type { ReactNode } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'

const api = vi.hoisted(() => ({ apiFetch: vi.fn() }))
vi.mock('@/lib/api', () => api)
vi.mock('@xyflow/react', () => ({
  ReactFlow: ({ children }: { children?: ReactNode }) => <div data-testid="workflow-canvas">{children}</div>,
  Background: () => null,
  Controls: () => null,
  MiniMap: () => null,
  BackgroundVariant: { Dots: 'dots' },
  applyEdgeChanges: (_changes: unknown, edges: unknown) => edges,
  applyNodeChanges: (_changes: unknown, nodes: unknown) => nodes,
}))

import { confirmWorkflowImpact, WorkflowBuilder } from '@/app/workflow/workflow-builder'

describe('workflow builder resilience', () => {
  afterEach(() => cleanup())

  it('stays visible when an older or partially unavailable API omits optional collections', async () => {
    api.apiFetch.mockResolvedValue(new Response('{}', {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }))
    render(<WorkflowBuilder />)
    await waitFor(() => expect(screen.getByRole('main', { name: 'TSX Core Workflow Builder' })).toBeVisible())
    expect(screen.getByTestId('workflow-canvas')).toBeVisible()
    expect(screen.getByText('Noch keine aktive Revision')).toBeVisible()
  })

  it('requires the exact server-issued phrase for destructive workflow activation', () => {
    const prompt = vi.spyOn(window, 'prompt')
    const impact = {
      changed: [{ channelId: '-1001', accountId: 'account-1' }],
      removed: [], destructive: true, confirmation: 'ACTIVATE WORKFLOW IMPACT',
    }
    prompt.mockReturnValue('yes')
    expect(confirmWorkflowImpact(impact)).toBeNull()
    prompt.mockReturnValue('ACTIVATE WORKFLOW IMPACT')
    expect(confirmWorkflowImpact(impact)).toBe('ACTIVATE WORKFLOW IMPACT')
    expect(prompt).toHaveBeenLastCalledWith(expect.stringContaining('Zur Bestätigung exakt eingeben'))
    prompt.mockRestore()
  })
})

/*
Copyright (C) 2023-2026 QuantumNous

This program is free software: you can redistribute it and/or modify
it under the terms of the GNU Affero General Public License as
published by the Free Software Foundation, either version 3 of the
License, or (at your option) any later version.

This program is distributed in the hope that it will be useful,
but WITHOUT ANY WARRANTY; without even the implied warranty of
MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the
GNU Affero General Public License for more details.

You should have received a copy of the GNU Affero General Public License
along with this program. If not, see <https://www.gnu.org/licenses/>.

For commercial licensing, please contact support@quantumnous.com
*/
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  getChannelDailyUsage,
  testChannelKey,
  updateChannelKeyDailyLimits,
} from '../../../api'
import { ChannelDailyUsage } from '../channel-daily-usage'

// The module id must resolve to the same file the component imports
// (../../api from drawers/), so from drawers/__tests__/ it is ../../../api.
vi.mock('../../../api', () => ({
  getChannelDailyUsage: vi.fn(),
  updateChannelKeyDailyLimits: vi.fn(),
  testChannelKey: vi.fn(),
}))

const mockedFetch = vi.mocked(getChannelDailyUsage)
const mockedUpdate = vi.mocked(updateChannelKeyDailyLimits)
const mockedTest = vi.mocked(testChannelKey)

function usage(overrides: Record<string, unknown> = {}) {
  return {
    success: true,
    data: {
      channel_id: 5,
      name: 'demo',
      status: 1,
      daily_token_limit: 50000,
      tokens_used: 1234,
      daily_request_limit: 7,
      requests_used: 3,
      reject_selection_attempts_today: 6,
      retry_times: 0,
      keys: undefined,
      ...overrides,
    },
  }
}

async function renderUsage() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  })
  const view = render(
    <QueryClientProvider client={client}>
      <ChannelDailyUsage channelId={5} />
    </QueryClientProvider>
  )
  // jest-dom's toContain() takes a node, not a fragment string: wait on the
  // mocked fetch, then assert through the screen queries below.
  await vi.waitFor(() => expect(mockedFetch).toHaveBeenCalledWith(5))
  await screen.findByText('Daily budget usage')
  return view
}

describe('ChannelDailyUsage', () => {
  afterEach(() => {
    cleanup()
    mockedFetch.mockReset()
    mockedUpdate.mockReset()
    mockedTest.mockReset()
  })

  it('shows both budgets with their usage and the skipped attempts', async () => {
    mockedFetch.mockResolvedValue(usage() as never)
    await renderUsage()

    expect(mockedFetch).toHaveBeenCalledWith(5)
    // The value is rendered as separate text nodes ("1,234", " / ", "50,000"),
    // so assert on the row's textContent instead of a combined matcher.
    const tokenRow =
      screen.getByText('Tokens today').parentElement?.textContent || ''
    expect(tokenRow).toContain('1,234')
    expect(tokenRow).toContain('50,000')
    const requestRow =
      screen.getByText('Requests today').parentElement?.textContent || ''
    expect(requestRow).toContain('3')
    expect(requestRow).toContain('7')
    expect(
      screen.getByText('Selection attempts skipped today')
    ).toBeInTheDocument()
  })

  it('labels an unset budget as unlimited instead of hiding it', async () => {
    mockedFetch.mockResolvedValue(
      usage({
        daily_token_limit: 0,
        daily_request_limit: 2,
        requests_used: 1,
      }) as never
    )
    await renderUsage()

    const tokenRow =
      screen.getByText('Tokens today').parentElement?.textContent || ''
    expect(tokenRow).toContain('Unlimited')
    expect(tokenRow).toContain('1,234')
    // The request budget is still a real budget: it must show used/limit, not
    // fall through to the unlimited branch.
    const requestRow =
      screen.getByText('Requests today').parentElement?.textContent || ''
    expect(requestRow).toContain('1 / 2')
    expect(requestRow).not.toContain('Unlimited')
  })

  it('lists per-key budgets and usage for a multi-key channel', async () => {
    mockedFetch.mockResolvedValue(
      usage({
        daily_token_limit: 0,
        daily_request_limit: 0,
        keys: [
          {
            index: 0,
            key_tail: '***ey-a',
            status: 1,
            disabled_reason: '',
            disabled_time: 0,
            daily_token_limit: 1000,
            tokens_used: 40,
            daily_request_limit: 5,
            rpm_limit: 0,
            cooldown_remaining_seconds: 0,
            recoveries_today: 0,
            requests_used: 2,
          },
          {
            index: 1,
            key_tail: '***ey-b',
            status: 2,
            disabled_reason: 'auto: invalid key',
            disabled_time: 1700000000,
            daily_token_limit: 0,
            tokens_used: 0,
            daily_request_limit: 0,
            rpm_limit: 0,
            cooldown_remaining_seconds: 0,
            recoveries_today: 0,
            requests_used: 0,
          },
        ],
      }) as never
    )
    await renderUsage()

    // A key-only budget must keep the panel visible.
    expect(screen.getByText('Daily budget usage')).toBeInTheDocument()
    expect(screen.getByText('Keys')).toBeInTheDocument()
    expect(screen.getByText('#0 ***ey-a')).toBeInTheDocument()
    expect(screen.getByText('#1 ***ey-b')).toBeInTheDocument()
    expect(screen.getByText('Disabled: auto: invalid key')).toBeInTheDocument()
  })

  it('saves edited per-key budgets, omitting cleared limits', async () => {
    mockedFetch.mockResolvedValue(
      usage({
        daily_token_limit: 0,
        daily_request_limit: 0,
        keys: [
          {
            index: 0,
            key_tail: '***ey-a',
            status: 1,
            disabled_reason: '',
            disabled_time: 0,
            daily_token_limit: 1000,
            tokens_used: 40,
            daily_request_limit: 5,
            rpm_limit: 0,
            cooldown_remaining_seconds: 0,
            recoveries_today: 0,
            requests_used: 2,
          },
          {
            index: 1,
            key_tail: '***ey-b',
            status: 1,
            disabled_reason: '',
            disabled_time: 0,
            daily_token_limit: 0,
            tokens_used: 0,
            daily_request_limit: 0,
            rpm_limit: 0,
            cooldown_remaining_seconds: 0,
            recoveries_today: 0,
            requests_used: 0,
          },
        ],
      }) as never
    )
    mockedUpdate.mockResolvedValue({ success: true } as never)
    await renderUsage()

    await userEvent.click(
      screen.getByRole('button', { name: 'Edit per-key budgets' })
    )
    // Clearing a field means unlimited: it must leave the stored map instead of
    // writing 0, so the payload only carries real limits.
    await userEvent.clear(screen.getByLabelText('Daily token limit #0'))
    const request0 = screen.getByLabelText('Daily request limit #0')
    await userEvent.clear(request0)
    await userEvent.type(request0, '9')
    const rpm0 = screen.getByLabelText('Requests per minute limit #0')
    await userEvent.type(rpm0, '30')
    await userEvent.click(screen.getByRole('button', { name: 'Save' }))

    await vi.waitFor(() =>
      expect(mockedUpdate).toHaveBeenCalledWith(5, {
        key_daily_token_limits: {},
        key_daily_request_limits: { '0': 9 },
        key_rpm_limits: { '0': 30 },
      })
    )
  })

  it('refuses to save a negative per-key budget', async () => {
    mockedFetch.mockResolvedValue(
      usage({
        daily_token_limit: 0,
        daily_request_limit: 0,
        keys: [
          {
            index: 0,
            key_tail: '***ey-a',
            status: 1,
            disabled_reason: '',
            disabled_time: 0,
            daily_token_limit: 1000,
            tokens_used: 40,
            daily_request_limit: 5,
            rpm_limit: 0,
            cooldown_remaining_seconds: 0,
            recoveries_today: 0,
            requests_used: 2,
          },
        ],
      }) as never
    )
    await renderUsage()

    await userEvent.click(
      screen.getByRole('button', { name: 'Edit per-key budgets' })
    )
    const token0 = screen.getByLabelText('Daily token limit #0')
    await userEvent.clear(token0)
    await userEvent.type(token0, '-1')
    await userEvent.click(screen.getByRole('button', { name: 'Save' }))

    expect(mockedUpdate).not.toHaveBeenCalled()
  })

  it('keeps the editor reachable before any per-key budget exists', async () => {
    mockedFetch.mockResolvedValue(
      usage({
        daily_token_limit: 0,
        daily_request_limit: 0,
        keys: [
          {
            index: 0,
            key_tail: '***ey-a',
            status: 1,
            disabled_reason: '',
            disabled_time: 0,
            daily_token_limit: 0,
            tokens_used: 0,
            daily_request_limit: 0,
            rpm_limit: 0,
            cooldown_remaining_seconds: 0,
            recoveries_today: 0,
            requests_used: 0,
          },
        ],
      }) as never
    )
    await renderUsage()

    // The panel is the only place per-key budgets can be set, so it must render
    // for a multi-key channel even when every limit is still zero.
    expect(screen.getByText('Daily budget usage')).toBeInTheDocument()
    expect(
      screen.getByRole('button', { name: 'Edit per-key budgets' })
    ).toBeInTheDocument()
  })

  it('shows the upstream cooldown and the recovery count', async () => {
    mockedFetch.mockResolvedValue(
      usage({
        daily_token_limit: 0,
        daily_request_limit: 0,
        keys: [
          {
            index: 0,
            key_tail: '***ey-a',
            status: 1,
            disabled_reason: '',
            disabled_time: 0,
            daily_token_limit: 0,
            tokens_used: 0,
            daily_request_limit: 0,
            requests_used: 0,
            rpm_limit: 60,
            cooldown_remaining_seconds: 12,
            recoveries_today: 2,
          },
        ],
      }) as never
    )
    await renderUsage()

    expect(
      screen.getByText('Cooling down after upstream rate limit: 12s')
    ).toBeInTheDocument()
    expect(
      screen.getByText('Automatic recoveries today: 2')
    ).toBeInTheDocument()
  })

  it('tests a single key through the API', async () => {
    mockedFetch.mockResolvedValue(
      usage({
        daily_token_limit: 0,
        daily_request_limit: 0,
        keys: [
          {
            index: 0,
            key_tail: '***ey-a',
            status: 1,
            disabled_reason: '',
            disabled_time: 0,
            daily_token_limit: 0,
            tokens_used: 0,
            daily_request_limit: 0,
            requests_used: 0,
            rpm_limit: 0,
            cooldown_remaining_seconds: 0,
            recoveries_today: 0,
          },
        ],
      }) as never
    )
    mockedTest.mockResolvedValue({
      success: true,
      message: '',
      time: 0.12,
      index: 0,
      key_tail: '***ey-a',
    } as never)
    await renderUsage()

    await userEvent.click(screen.getByRole('button', { name: 'Test' }))

    await vi.waitFor(() => expect(mockedTest).toHaveBeenCalledWith(5, 0))
  })

  it('shows the externally reported account state and failure count', async () => {
    mockedFetch.mockResolvedValue(
      usage({
        daily_token_limit: 0,
        daily_request_limit: 0,
        keys: [
          {
            index: 0,
            key_tail: '***ey-a',
            status: 1,
            disabled_reason: '',
            disabled_time: 0,
            daily_token_limit: 0,
            tokens_used: 0,
            daily_request_limit: 0,
            requests_used: 0,
            rpm_limit: 0,
            cooldown_remaining_seconds: 0,
            recoveries_today: 0,
            failures_today: 3,
            external_state: 'quota',
            external_reason: 'monthly quota exhausted',
            external_until: 0,
          },
        ],
      }) as never
    )
    await renderUsage()

    expect(
      screen.getByText(
        'Account state: Quota exhausted: monthly quota exhausted'
      )
    ).toBeInTheDocument()
    expect(screen.getByText('Failures today: 3')).toBeInTheDocument()
  })

  it('renders nothing when the channel has no budget configured', async () => {
    mockedFetch.mockResolvedValue(
      usage({ daily_token_limit: 0, daily_request_limit: 0 }) as never
    )
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    })
    render(
      <QueryClientProvider client={client}>
        <ChannelDailyUsage channelId={5} />
      </QueryClientProvider>
    )
    await vi.waitFor(() => expect(mockedFetch).toHaveBeenCalledWith(5))
    expect(screen.queryByText('Daily budget usage')).toBeNull()
    expect(screen.queryByText('Tokens today')).toBeNull()
  })
})

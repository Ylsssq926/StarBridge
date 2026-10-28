import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'

import { ErrorState } from '@/components/error-state'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Skeleton } from '@/components/ui/skeleton'
import { formatNumber } from '@/lib/format'
import { handleServerError } from '@/lib/handle-server-error'
import { requireServerSuccess } from '@/lib/server-error-message'

import {
  getChannelDailyUsage,
  updateChannelKeyDailyLimits,
  type ChannelDailyUsage as DailyUsage,
} from '../../api'
import { channelsQueryKeys } from '../../lib/channel-actions'

function UsageRow({
  label,
  used,
  limit,
}: {
  label: string
  used: number
  limit: number
}) {
  const { t } = useTranslation()

  return (
    <div className='flex items-baseline justify-between gap-3 text-xs'>
      <span className='text-muted-foreground'>{label}</span>
      <span className='font-medium tabular-nums'>
        {limit > 0 ? (
          <>
            {formatNumber(used)} / {formatNumber(limit)}
          </>
        ) : (
          <>
            {formatNumber(used)} · <span>{t('Unlimited')}</span>
          </>
        )}
      </span>
    </div>
  )
}

// Empty means "no budget"; anything else must be a non-negative whole number.
function parseDailyLimit(raw: string): number | null {
  const trimmed = raw.trim()
  if (trimmed === '') return 0
  const value = Number(trimmed)
  return Number.isInteger(value) && value >= 0 ? value : null
}

type KeyBudgetDraft = Record<number, { tokens: string; requests: string }>

// Read-only view of the two per-day budgets plus how many times this channel was
// skipped today. The numbers come from the same counters enforcement reads. The
// rejection figure counts channel-selection attempts, not requests: one blocked
// request is counted once per attempt, so it is labelled as attempts.
//
// Multi-key channels also get an inline editor for per-key budgets: those are
// the limits that let one exhausted key leave the pool without taking the
// channel offline, so they belong next to the numbers they gate.
export function ChannelDailyUsage({ channelId }: { channelId: number }) {
  const { t } = useTranslation()
  const queryClient = useQueryClient()
  const [draft, setDraft] = useState<KeyBudgetDraft | null>(null)

  const { data, isLoading, isError, refetch, isFetching } = useQuery({
    queryKey: channelsQueryKeys.dailyUsage(channelId),
    queryFn: async () =>
      requireServerSuccess(await getChannelDailyUsage(channelId)),
    enabled: channelId > 0,
    meta: { errorToast: false },
  })

  const saveKeyBudgets = useMutation({
    mutationFn: async (payload: {
      key_daily_token_limits: Record<string, number>
      key_daily_request_limits: Record<string, number>
    }) =>
      requireServerSuccess(
        await updateChannelKeyDailyLimits(channelId, payload)
      ),
    onSuccess: () => {
      toast.success(t('Per-key daily budgets saved'))
      setDraft(null)
      void queryClient.invalidateQueries({
        queryKey: channelsQueryKeys.dailyUsage(channelId),
      })
      void queryClient.invalidateQueries({
        queryKey: channelsQueryKeys.lists(),
      })
    },
    onError: (error) => {
      handleServerError(error, t('Failed to save per-key daily budgets'))
    },
  })

  if (isLoading) {
    return <Skeleton className='h-16 w-full' />
  }

  if (isError) {
    return (
      <ErrorState
        className='min-h-0 p-3'
        title={t('Daily budget usage unavailable')}
        onRetry={() => {
          void refetch()
        }}
      />
    )
  }

  // requireServerSuccess() hands back the whole server envelope, so the payload
  // sits under .data. Reading the envelope itself yields undefined numbers and a
  // row that renders as "- · Unlimited", which looks plausible and is wrong.
  const usage: DailyUsage | undefined = data?.data
  if (
    !usage ||
    typeof usage.tokens_used !== 'number' ||
    typeof usage.requests_used !== 'number'
  ) {
    return null
  }

  const hasChannelBudget =
    usage.daily_token_limit > 0 || usage.daily_request_limit > 0
  // A multi-key channel can run on per-key budgets only; hiding the panel then
  // would hide exactly the numbers an operator needs. Keys without any budget
  // still keep the panel mounted, because that is where the budgets get set.
  const hasKeys = (usage.keys?.length ?? 0) > 0
  if (!hasChannelBudget && !hasKeys) {
    return null
  }

  const startEditing = (keys: NonNullable<DailyUsage['keys']>) => {
    const next: KeyBudgetDraft = {}
    for (const key of keys) {
      next[key.index] = {
        tokens: key.daily_token_limit > 0 ? String(key.daily_token_limit) : '',
        requests:
          key.daily_request_limit > 0 ? String(key.daily_request_limit) : '',
      }
    }
    setDraft(next)
  }

  const submitDraft = () => {
    if (!draft) return
    const tokenLimits: Record<string, number> = {}
    const requestLimits: Record<string, number> = {}
    for (const [index, entry] of Object.entries(draft)) {
      const tokens = parseDailyLimit(entry.tokens)
      const requests = parseDailyLimit(entry.requests)
      if (tokens === null || requests === null) {
        toast.error(
          t(
            'Enter a whole number of at least 0, or leave the field empty for unlimited'
          )
        )
        return
      }
      if (tokens > 0) tokenLimits[index] = tokens
      if (requests > 0) requestLimits[index] = requests
    }
    saveKeyBudgets.mutate({
      key_daily_token_limits: tokenLimits,
      key_daily_request_limits: requestLimits,
    })
  }

  return (
    <div className='rounded-md border p-3'>
      <div className='mb-2 flex items-center justify-between gap-3'>
        <span className='text-muted-foreground text-xs font-medium'>
          {t('Daily budget usage')}
        </span>
        <button
          type='button'
          className='text-muted-foreground hover:text-foreground text-xs underline-offset-4 hover:underline'
          onClick={() => {
            void refetch()
          }}
          disabled={isFetching}
        >
          {isFetching ? t('Refreshing...') : t('Refresh')}
        </button>
      </div>
      <div className='space-y-1.5'>
        <UsageRow
          label={t('Tokens today')}
          used={usage.tokens_used}
          limit={usage.daily_token_limit}
        />
        <UsageRow
          label={t('Requests today')}
          used={usage.requests_used}
          limit={usage.daily_request_limit}
        />
        <div className='flex items-baseline justify-between gap-3 text-xs'>
          <span className='text-muted-foreground'>
            {t('Selection attempts skipped today')}
          </span>
          <span className='font-medium tabular-nums'>
            {formatNumber(usage.reject_selection_attempts_today)}
          </span>
        </div>
      </div>
      <p className='text-muted-foreground mt-2 text-xs'>
        {t(
          'A blocked request is counted once per channel-selection attempt (retries included).'
        )}
      </p>

      {usage.keys && usage.keys.length > 0 ? (
        <div className='border-t pt-2'>
          <div className='flex items-center justify-between gap-2'>
            <p className='text-muted-foreground text-xs font-medium'>
              {t('Keys')}
            </p>
            {draft === null ? (
              <Button
                type='button'
                variant='ghost'
                size='xs'
                onClick={() => startEditing(usage.keys ?? [])}
              >
                {t('Edit per-key budgets')}
              </Button>
            ) : null}
          </div>
          <div className='mt-1 space-y-2'>
            {usage.keys.map((key) => (
              <div key={key.index} className='space-y-1'>
                <div className='flex items-center justify-between gap-2 text-xs'>
                  <span className='font-medium'>
                    #{key.index} {key.key_tail}
                  </span>
                  {key.status !== 1 ? (
                    <span className='text-destructive'>
                      {t('Disabled')}
                      {key.disabled_reason ? `: ${key.disabled_reason}` : ''}
                    </span>
                  ) : null}
                </div>
                {draft !== null ? (
                  <>
                    <div className='flex items-center justify-between gap-2 text-xs'>
                      <span className='text-muted-foreground'>
                        {t('Tokens used today')}
                      </span>
                      <span className='flex items-center gap-1 tabular-nums'>
                        <span className='font-medium'>
                          {formatNumber(key.tokens_used)}
                        </span>
                        <span className='text-muted-foreground'>/</span>
                        <Input
                          type='number'
                          min={0}
                          step={1}
                          className='h-7 w-28 text-xs'
                          aria-label={`${t('Daily token limit')} #${key.index}`}
                          placeholder={t('Unlimited')}
                          value={draft[key.index]?.tokens ?? ''}
                          onChange={(event) => {
                            const value = event.target.value
                            setDraft((current) =>
                              current
                                ? {
                                    ...current,
                                    [key.index]: {
                                      ...current[key.index],
                                      tokens: value,
                                    },
                                  }
                                : current
                            )
                          }}
                        />
                      </span>
                    </div>
                    <div className='flex items-center justify-between gap-2 text-xs'>
                      <span className='text-muted-foreground'>
                        {t('Requests used today')}
                      </span>
                      <span className='flex items-center gap-1 tabular-nums'>
                        <span className='font-medium'>
                          {formatNumber(key.requests_used)}
                        </span>
                        <span className='text-muted-foreground'>/</span>
                        <Input
                          type='number'
                          min={0}
                          step={1}
                          className='h-7 w-28 text-xs'
                          aria-label={`${t('Daily request limit')} #${key.index}`}
                          placeholder={t('Unlimited')}
                          value={draft[key.index]?.requests ?? ''}
                          onChange={(event) => {
                            const value = event.target.value
                            setDraft((current) =>
                              current
                                ? {
                                    ...current,
                                    [key.index]: {
                                      ...current[key.index],
                                      requests: value,
                                    },
                                  }
                                : current
                            )
                          }}
                        />
                      </span>
                    </div>
                  </>
                ) : (
                  <>
                    <UsageRow
                      label={t('Tokens used today')}
                      used={key.tokens_used}
                      limit={key.daily_token_limit}
                    />
                    <UsageRow
                      label={t('Requests used today')}
                      used={key.requests_used}
                      limit={key.daily_request_limit}
                    />
                  </>
                )}
              </div>
            ))}
          </div>
          {draft !== null ? (
            <div className='mt-2 flex justify-end gap-2'>
              <Button
                type='button'
                variant='outline'
                size='sm'
                disabled={saveKeyBudgets.isPending}
                onClick={() => setDraft(null)}
              >
                {t('Cancel')}
              </Button>
              <Button
                type='button'
                size='sm'
                disabled={saveKeyBudgets.isPending}
                onClick={submitDraft}
              >
                {saveKeyBudgets.isPending ? t('Saving...') : t('Save')}
              </Button>
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  )
}

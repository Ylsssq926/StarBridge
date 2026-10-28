import { useQuery } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'

import { ErrorState } from '@/components/error-state'
import { Skeleton } from '@/components/ui/skeleton'
import { formatNumber } from '@/lib/format'
import { requireServerSuccess } from '@/lib/server-error-message'

import { getChannelDailyUsage, type ChannelDailyUsage as DailyUsage } from '../../api'
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
      <span className='tabular-nums font-medium'>
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

// Read-only view of the two per-day budgets plus how many times this channel was
// skipped today. The numbers come from the same counters enforcement reads. The
// rejection figure counts channel-selection attempts, not requests: one blocked
// request is counted once per attempt, so it is labelled as attempts.
export function ChannelDailyUsage({ channelId }: { channelId: number }) {
  const { t } = useTranslation()

  const { data, isLoading, isError, refetch, isFetching } = useQuery({
    queryKey: channelsQueryKeys.dailyUsage(channelId),
    queryFn: async () =>
      requireServerSuccess(await getChannelDailyUsage(channelId)),
    enabled: channelId > 0,
    meta: { errorToast: false },
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
  // would hide exactly the numbers an operator needs.
  const hasKeyBudget = (usage.keys ?? []).some(
    (key) => key.daily_token_limit > 0 || key.daily_request_limit > 0
  )
  if (!hasChannelBudget && !hasKeyBudget) {
    return null
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
          <span className='tabular-nums font-medium'>
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
          <p className='text-muted-foreground text-xs font-medium'>
            {t('Keys')}
          </p>
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
              </div>
            ))}
          </div>
        </div>
      ) : null}
    </div>
  )
}

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
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'

import { Dialog } from '@/components/dialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { handleServerError } from '@/lib/handle-server-error'

import { getUserDailyBudget, updateUserDailyBudget } from '../api'

interface UserDailyBudgetDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  userId: number
  username?: string
}

/**
 * Per-user daily budgets. Limits live in the user's JSON setting; the usage
 * numbers are the counters the gateway actually enforces, so what is shown here
 * is what will answer 429.
 */
export function UserDailyBudgetDialog(props: UserDailyBudgetDialogProps) {
  const { t } = useTranslation()
  const [loading, setLoading] = useState(false)
  const [saving, setSaving] = useState(false)
  const [tokenLimit, setTokenLimit] = useState('0')
  const [requestLimit, setRequestLimit] = useState('0')
  const [tokensUsed, setTokensUsed] = useState(0)
  const [requestsUsed, setRequestsUsed] = useState(0)

  useEffect(() => {
    if (!props.open || props.userId <= 0) return
    let cancelled = false
    const load = async () => {
      setLoading(true)
      try {
        const res = await getUserDailyBudget(props.userId)
        if (cancelled) return
        if (res.success && res.data) {
          setTokenLimit(String(res.data.daily_token_limit ?? 0))
          setRequestLimit(String(res.data.daily_request_limit ?? 0))
          setTokensUsed(res.data.tokens_used ?? 0)
          setRequestsUsed(res.data.requests_used ?? 0)
        } else {
          handleServerError(res, t('Failed to load daily budget'))
        }
      } catch (error: unknown) {
        if (!cancelled) handleServerError(error, t('Failed to load daily budget'))
      } finally {
        if (!cancelled) setLoading(false)
      }
    }
    void load()
    return () => {
      cancelled = true
    }
  }, [props.open, props.userId, t])

  const handleSave = async () => {
    const tokens = Number(tokenLimit)
    const requests = Number(requestLimit)
    if (!Number.isFinite(tokens) || tokens < 0 || !Number.isFinite(requests) || requests < 0) {
      toast.error(t('Daily limits must be zero or a positive number'))
      return
    }
    setSaving(true)
    try {
      const res = await updateUserDailyBudget(props.userId, {
        daily_token_limit: tokens,
        daily_request_limit: requests,
      })
      if (res.success) {
        toast.success(t('Saved'))
        props.onOpenChange(false)
      } else {
        handleServerError(res, t('Failed to save daily budget'))
      }
    } catch (error: unknown) {
      handleServerError(error, t('Failed to save daily budget'))
    } finally {
      setSaving(false)
    }
  }

  return (
    <Dialog
      open={props.open}
      onOpenChange={props.onOpenChange}
      title={t('Daily Budget')}
      description={props.username ?? ''}
      contentHeight='auto'
      bodyClassName='space-y-4'
      footer={
        <>
          <Button variant='outline' onClick={() => props.onOpenChange(false)}>
            {t('Cancel')}
          </Button>
          <Button onClick={handleSave} disabled={loading || saving}>
            {saving ? t('Saving...') : t('Save')}
          </Button>
        </>
      }
    >
      <p className='text-muted-foreground text-sm'>
        {t('Tokens used today')}: {tokensUsed} · {t('Requests used today')}: {requestsUsed}
      </p>
      <div className='space-y-2'>
        <Label htmlFor='user-daily-token-limit'>{t('Daily token limit')}</Label>
        <Input
          id='user-daily-token-limit'
          type='number'
          min={0}
          value={tokenLimit}
          onChange={(event) => setTokenLimit(event.target.value)}
          disabled={loading}
        />
      </div>
      <div className='space-y-2'>
        <Label htmlFor='user-daily-request-limit'>{t('Daily request limit')}</Label>
        <Input
          id='user-daily-request-limit'
          type='number'
          min={0}
          value={requestLimit}
          onChange={(event) => setRequestLimit(event.target.value)}
          disabled={loading}
        />
      </div>
      <p className='text-muted-foreground text-xs'>{t('0 means unlimited')}</p>
    </Dialog>
  )
}

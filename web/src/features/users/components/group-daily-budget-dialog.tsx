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
import { useCallback, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'

import { Dialog } from '@/components/dialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { handleServerError } from '@/lib/handle-server-error'

import {
  getGroupDailyBudgets,
  updateGroupDailyBudget,
  type GroupDailyBudget,
} from '../api'

interface GroupDailyBudgetDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
}

/**
 * Group-level daily budgets. One row per configured group; the usage shown is
 * the same counter enforcement reads, so it answers "who in this group spent how
 * much today" without a separate report.
 */
export function GroupDailyBudgetDialog(props: GroupDailyBudgetDialogProps) {
  const { t } = useTranslation()
  const [rows, setRows] = useState<GroupDailyBudget[]>([])
  const [loading, setLoading] = useState(false)
  const [saving, setSaving] = useState(false)
  const [group, setGroup] = useState('')
  const [tokenLimit, setTokenLimit] = useState('0')
  const [requestLimit, setRequestLimit] = useState('0')

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const res = await getGroupDailyBudgets()
      if (res.success) {
        setRows(res.data ?? [])
      } else {
        handleServerError(res, t('Failed to load daily budget'))
      }
    } catch (error: unknown) {
      handleServerError(error, t('Failed to load daily budget'))
    } finally {
      setLoading(false)
    }
  }, [t])

  useEffect(() => {
    if (props.open) {
      void load()
    }
  }, [props.open, load])

  const pickRow = (row: GroupDailyBudget) => {
    setGroup(row.group)
    setTokenLimit(String(row.daily_token_limit ?? 0))
    setRequestLimit(String(row.daily_request_limit ?? 0))
  }

  const handleSave = async () => {
    const name = group.trim()
    if (!name) {
      toast.error(t('Group name'))
      return
    }
    const tokens = Number(tokenLimit)
    const requests = Number(requestLimit)
    if (!Number.isFinite(tokens) || tokens < 0 || !Number.isFinite(requests) || requests < 0) {
      toast.error(t('Daily limits must be zero or a positive number'))
      return
    }
    setSaving(true)
    try {
      const res = await updateGroupDailyBudget({
        group: name,
        daily_token_limit: tokens,
        daily_request_limit: requests,
      })
      if (res.success) {
        toast.success(t('Saved'))
        await load()
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
      title={t('Group daily budgets')}
      contentHeight='auto'
      bodyClassName='space-y-4'
      footer={
        <>
          <Button variant='outline' onClick={() => props.onOpenChange(false)}>
            {t('Cancel')}
          </Button>
          <Button onClick={handleSave} disabled={saving}>
            {saving ? t('Saving...') : t('Save')}
          </Button>
        </>
      }
    >
      <div className='space-y-3'>
        <p className='text-muted-foreground text-sm'>{t('Configured groups')}</p>
        {rows.length === 0 ? (
          <p className='text-muted-foreground text-xs'>
            {loading ? t('Loading') : t('No group budget configured yet')}
          </p>
        ) : (
          <div className='space-y-1'>
            {rows.map((row) => (
              <button
                key={row.group}
                type='button'
                className='hover:bg-muted flex w-full items-center justify-between rounded-md px-2 py-1 text-left text-sm'
                onClick={() => pickRow(row)}
              >
                <span className='font-medium'>{row.group}</span>
                <span className='text-muted-foreground text-xs'>
                  {t('Tokens used today')}: {row.tokens_used}/{row.daily_token_limit || '∞'} ·{' '}
                  {t('Requests used today')}: {row.requests_used}/{row.daily_request_limit || '∞'}
                </span>
              </button>
            ))}
          </div>
        )}
      </div>

      <div className='space-y-2'>
        <Label htmlFor='group-daily-budget-name'>{t('Group')}</Label>
        <Input
          id='group-daily-budget-name'
          value={group}
          onChange={(event) => setGroup(event.target.value)}
          placeholder={t('Group name')}
        />
      </div>
      <div className='space-y-2'>
        <Label htmlFor='group-daily-token-limit'>{t('Daily token limit')}</Label>
        <Input
          id='group-daily-token-limit'
          type='number'
          min={0}
          value={tokenLimit}
          onChange={(event) => setTokenLimit(event.target.value)}
        />
      </div>
      <div className='space-y-2'>
        <Label htmlFor='group-daily-request-limit'>{t('Daily request limit')}</Label>
        <Input
          id='group-daily-request-limit'
          type='number'
          min={0}
          value={requestLimit}
          onChange={(event) => setRequestLimit(event.target.value)}
        />
      </div>
      <p className='text-muted-foreground text-xs'>{t('0 means unlimited')}</p>
    </Dialog>
  )
}

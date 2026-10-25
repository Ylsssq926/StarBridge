package controller

import (
	"errors"
	"strconv"

	"github.com/QuantumNous/new-api/common"
	"github.com/QuantumNous/new-api/model"

	"github.com/gin-gonic/gin"
)

// channelDailyUsageSnapshot renders one channel's per-day budget state. Limits
// come from the channel settings, usage and rejections from the per-day
// counters, which roll over at local midnight.
func channelDailyUsageSnapshot(channel *model.Channel) gin.H {
	setting := channel.GetSetting()
	return gin.H{
		"channel_id":          channel.Id,
		"name":                channel.Name,
		"status":              channel.Status,
		"daily_token_limit":   setting.DailyTokenLimit,
		"tokens_used":         common.GetChannelDailyTokenUsage(channel.Id),
		"daily_request_limit": setting.DailyRequestLimit,
		"requests_used":       common.GetChannelDailyRequestUsage(channel.Id),
		// A blocked request makes multiple channel-selection attempts (measured: 2
		// and each attempt that finds this channel over budget counts once. The
		// field name says so, and retry_times is returned next to it so the
		// number can be interpreted without guessing.
		"reject_selection_attempts_today": common.GetChannelDailyRejectUsage(channel.Id),
		"retry_times":                     model.CurrentRequestPolicy().RetryTimes,
	}
}

// GetChannelDailyUsage is read-only observability for the two per-day budgets:
// GET /api/channel/daily_usage/:id for one channel, GET /api/channel/daily_usage
// for every channel that has a budget configured or any usage today. It never
// changes selection behaviour, and it does not create a new source of truth: the
// numbers are the same counters enforcement reads.
func GetChannelDailyUsage(c *gin.Context) {
	if idParam := c.Param("id"); idParam != "" {
		id, err := strconv.Atoi(idParam)
		if err != nil || id <= 0 {
			common.ApiError(c, errors.New("invalid channel id"))
			return
		}
		channel, err := model.CacheGetChannel(id)
		if err != nil || channel == nil {
			// Channel selection reads a cache that syncs on a delay, so a channel
			// created seconds ago is legitimately missing from it. Observability
			// must still answer for it, hence the direct DB read (selectAll=false
			// keeps the upstream key out of memory).
			channel, err = model.GetChannelById(id, false)
		}
		if err != nil {
			common.ApiError(c, err)
			return
		}
		if channel == nil {
			common.ApiError(c, errors.New("channel not found"))
			return
		}
		common.ApiSuccess(c, channelDailyUsageSnapshot(channel))
		return
	}

	// selectAll=false is deliberate: it makes GORM omit the `key` column, so this
	// read never loads upstream credentials into memory just to report counters.
	// Limit(-1) removes pagination instead of disabling it with a magic number.
	channels, err := model.GetAllChannels(0, -1, false, true)
	if err != nil {
		common.ApiError(c, err)
		return
	}
	items := make([]gin.H, 0, len(channels))
	for _, channel := range channels {
		if channel == nil {
			continue
		}
		snapshot := channelDailyUsageSnapshot(channel)
		setting := channel.GetSetting()
		// Keep the payload small: channels with no budget and no usage today are
		// not interesting on a dashboard.
		if setting.DailyTokenLimit <= 0 && setting.DailyRequestLimit <= 0 &&
			snapshot["tokens_used"].(int64) == 0 && snapshot["requests_used"].(int64) == 0 {
			continue
		}
		items = append(items, snapshot)
	}
	common.ApiSuccess(c, gin.H{"total": len(items), "channels": items})
}

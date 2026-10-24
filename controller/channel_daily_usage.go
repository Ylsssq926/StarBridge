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
		"rejects_today":       common.GetChannelDailyRejectUsage(channel.Id),
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

	channels, err := model.GetAllChannels(0, 0, true, true)
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

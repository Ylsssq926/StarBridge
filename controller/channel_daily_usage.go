package controller

import (
	"errors"
	"fmt"
	"strconv"
	"strings"

	"github.com/QuantumNous/new-api/common"
	"github.com/QuantumNous/new-api/model"

	"github.com/gin-gonic/gin"
)

// channelDailyUsageSnapshot renders one channel's per-day budget state. Limits
// come from the channel settings, usage and rejections from the per-day
// counters, which roll over at local midnight.
func channelDailyUsageSnapshot(channel *model.Channel) gin.H {
	setting := channel.GetSetting()
	snapshot := gin.H{
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

	// Multi-key channels also track each key separately: per-key budgets are
	// what lets one dead or exhausted account leave the pool without taking the
	// whole channel offline.
	if channel.ChannelInfo.IsMultiKey {
		setting := channel.GetSetting()
		keys := channel.GetKeys()
		rows := make([]gin.H, 0, len(keys))
		for index := range keys {
			key := strconv.Itoa(index)
			tokenLimit := setting.KeyDailyTokenLimits[key]
			requestLimit := setting.KeyDailyRequestLimits[key]
			rows = append(rows, gin.H{
				"index":                      index,
				"key_tail":                   maskKeyTail(keys[index]),
				"status":                     keyStatus(channel, index),
				"disabled_reason":            keyDisabledReason(channel, index),
				"disabled_time":              keyDisabledTime(channel, index),
				"daily_token_limit":          tokenLimit,
				"tokens_used":                common.GetKeyDailyTokenUsage(channel.Id, index),
				"daily_request_limit":        requestLimit,
				"requests_used":              common.GetKeyDailyRequestUsage(channel.Id, index),
				"rpm_limit":                  setting.KeyRPMLimits[key],
				"cooldown_remaining_seconds": common.KeyCooldownRemainingSeconds(channel.Id, index),
				"recoveries_today":           common.GetKeyDailyRecoveryCount(channel.Id, index),
			})
		}
		snapshot["keys"] = rows
	}
	return snapshot
}

// maskKeyTail exposes only the last four characters of a key so an operator can
// tell keys apart without the response becoming a credential dump.
func maskKeyTail(key string) string {
	key = strings.TrimSpace(key)
	if len(key) <= 4 {
		return strings.Repeat("*", len(key))
	}
	return "***" + key[len(key)-4:]
}

func keyStatus(channel *model.Channel, index int) int {
	if channel.ChannelInfo.MultiKeyStatusList == nil {
		return common.ChannelStatusEnabled
	}
	if status, ok := channel.ChannelInfo.MultiKeyStatusList[index]; ok {
		return status
	}
	return common.ChannelStatusEnabled
}

func keyDisabledReason(channel *model.Channel, index int) string {
	if channel.ChannelInfo.MultiKeyDisabledReason == nil {
		return ""
	}
	return channel.ChannelInfo.MultiKeyDisabledReason[index]
}

func keyDisabledTime(channel *model.Channel, index int) int64 {
	if channel.ChannelInfo.MultiKeyDisabledTime == nil {
		return 0
	}
	return channel.ChannelInfo.MultiKeyDisabledTime[index]
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
			// must still answer for it, so read the row with its keys: the per-key
			// rows below are built from the key list, and an empty list would hide
			// the very panel an operator uses to set those budgets. Only tails are
			// returned. (The list endpoint below stays keyless instead.)
			channel, err = model.GetChannelById(id, true)
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

type keyDailyLimitsRequest struct {
	KeyDailyTokenLimits   map[string]int64 `json:"key_daily_token_limits"`
	KeyDailyRequestLimits map[string]int64 `json:"key_daily_request_limits"`
	KeyRPMLimits          map[string]int64 `json:"key_rpm_limits"`
}

// validateKeyLimitMap rejects indexes that do not exist on the channel and
// negative budgets, instead of storing a limit nothing will ever read.
func validateKeyLimitMap(limits map[string]int64, keyCount int) error {
	for rawIndex, limit := range limits {
		index, err := strconv.Atoi(rawIndex)
		if err != nil || index < 0 || index >= keyCount {
			return fmt.Errorf("key index %q is out of range (channel has %d keys)", rawIndex, keyCount)
		}
		if limit < 0 {
			return fmt.Errorf("the limit for key %s must be >= 0 (0 means unlimited)", rawIndex)
		}
	}
	return nil
}

// UpdateChannelKeyDailyLimits sets per-key budgets on a multi-key channel:
// PUT /api/channel/:id/key_daily_limits.
//
// Only the setting column is written: this handler reads the channel without its
// keys (selectAll=false), and a full update from such a row would persist an
// empty key list.
func UpdateChannelKeyDailyLimits(c *gin.Context) {
	id, err := strconv.Atoi(c.Param("id"))
	if err != nil || id <= 0 {
		common.ApiError(c, errors.New("invalid channel id"))
		return
	}
	channel, err := model.GetChannelById(id, false)
	if err != nil {
		common.ApiError(c, err)
		return
	}
	if channel == nil {
		common.ApiError(c, errors.New("channel not found"))
		return
	}
	if !channel.ChannelInfo.IsMultiKey {
		common.ApiError(c, errors.New("per-key budgets only apply to multi-key channels"))
		return
	}
	var req keyDailyLimitsRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		common.ApiError(c, err)
		return
	}
	if err := validateKeyLimitMap(req.KeyDailyTokenLimits, channel.ChannelInfo.MultiKeySize); err != nil {
		common.ApiError(c, err)
		return
	}
	if err := validateKeyLimitMap(req.KeyDailyRequestLimits, channel.ChannelInfo.MultiKeySize); err != nil {
		common.ApiError(c, err)
		return
	}
	if err := validateKeyLimitMap(req.KeyRPMLimits, channel.ChannelInfo.MultiKeySize); err != nil {
		common.ApiError(c, err)
		return
	}
	setting := channel.GetSetting()
	setting.KeyDailyTokenLimits = req.KeyDailyTokenLimits
	setting.KeyDailyRequestLimits = req.KeyDailyRequestLimits
	setting.KeyRPMLimits = req.KeyRPMLimits
	if err := model.UpdateChannelSettingOnly(id, setting); err != nil {
		common.ApiError(c, err)
		return
	}
	common.ApiSuccess(c, gin.H{
		"channel_id":               id,
		"key_daily_token_limits":   req.KeyDailyTokenLimits,
		"key_daily_request_limits": req.KeyDailyRequestLimits,
		"key_rpm_limits":           req.KeyRPMLimits,
	})
}

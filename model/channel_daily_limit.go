package model

import (
	"errors"

	"github.com/QuantumNous/new-api/common"
)

// ErrChannelDailyTokenLimit means the model has candidate channels, but all of
// them reached their per-day token limit.
var ErrChannelDailyTokenLimit = errors.New("all candidate channels reached daily token limit")

func channelWithinDailyTokenLimit(channel *Channel) bool {
	if channel == nil {
		return true
	}
	return common.IsChannelDailyTokenUsageAvailable(channel.Id, channel.GetSetting().DailyTokenLimit)
}

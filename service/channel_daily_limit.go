package service

import (
	"fmt"

	"github.com/QuantumNous/new-api/common"
)

func IncreaseChannelDailyTokenUsage(channelID int, tokens int64) error {
	if err := common.IncreaseChannelDailyTokenUsage(channelID, tokens); err != nil {
		return fmt.Errorf("channel daily token usage NOT recorded, daily limit may not take effect: channel_id=%d, tokens=%d: %w", channelID, tokens, err)
	}
	return nil
}

// IncreaseChannelDailyRequestUsage records one billable request against the
// channel's per-day request budget. Unlike the token budget it also covers
// async tasks and per-call priced work, which report no usage at all.
func IncreaseChannelDailyRequestUsage(channelID int) error {
	if err := common.IncreaseChannelDailyRequestUsage(channelID); err != nil {
		return fmt.Errorf("channel daily request usage NOT recorded, daily limit may not take effect: channel_id=%d: %w", channelID, err)
	}
	return nil
}

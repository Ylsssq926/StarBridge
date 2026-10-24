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

package model

import (
	"fmt"
	"testing"

	"github.com/QuantumNous/new-api/common"
	"github.com/QuantumNous/new-api/dto"
)

func useDailyLimitFallbackForTest(t *testing.T) {
	t.Helper()
	oldEnabled, oldRDB := common.RedisEnabled, common.RDB
	common.RedisEnabled, common.RDB = false, nil
	t.Cleanup(func() {
		common.RedisEnabled, common.RDB = oldEnabled, oldRDB
	})
}

func channelWithDailyLimit(id int, limit int64) *Channel {
	setting := fmt.Sprintf(`{"daily_token_limit":%d}`, limit)
	return &Channel{Id: id, Setting: &setting}
}

func TestChannelSatisfiesFiltersDailyTokenLimit(t *testing.T) {
	useDailyLimitFallbackForTest(t)

	channelID := 990002
	channel := channelWithDailyLimit(channelID, 10)

	if ok, kind := ChannelSatisfiesFilters(channel, "test-model", nil); !ok || kind != "" {
		t.Fatalf("fresh channel: ok=%v kind=%q", ok, kind)
	}
	if err := common.IncreaseChannelDailyTokenUsage(channelID, 10); err != nil {
		t.Fatalf("increase usage: %v", err)
	}
	ok, kind := ChannelSatisfiesFilters(channel, "test-model", nil)
	if ok {
		t.Fatal("channel at its daily limit must be rejected")
	}
	if kind != dto.FilterDailyTokenLimit {
		t.Fatalf("kind = %q, want %q", kind, dto.FilterDailyTokenLimit)
	}
}

func TestFilterCandidateIDsDailyTokenLimit(t *testing.T) {
	useDailyLimitFallbackForTest(t)

	oldChannels := channelsIDM
	channelsIDM = map[int]*Channel{
		990003: channelWithDailyLimit(990003, 5),
		990004: channelWithDailyLimit(990004, 10),
	}
	t.Cleanup(func() { channelsIDM = oldChannels })

	if err := common.IncreaseChannelDailyTokenUsage(990004, 10); err != nil {
		t.Fatalf("increase usage: %v", err)
	}

	kept, kind := filterCandidateIDs([]int{990003, 990004}, "test-model", nil)
	if len(kept) != 1 || kept[0] != 990003 || kind != "" {
		t.Fatalf("kept=%v kind=%q, want [990003] and empty kind", kept, kind)
	}

	if err := common.IncreaseChannelDailyTokenUsage(990003, 5); err != nil {
		t.Fatalf("increase usage: %v", err)
	}
	kept, kind = filterCandidateIDs([]int{990003, 990004}, "test-model", nil)
	if len(kept) != 0 || kind != dto.FilterDailyTokenLimit {
		t.Fatalf("kept=%v kind=%q, want empty and %q", kept, kind, dto.FilterDailyTokenLimit)
	}
}

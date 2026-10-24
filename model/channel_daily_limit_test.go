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

func channelWithDailyLimits(id int, tokenLimit, requestLimit int64) *Channel {
	setting := fmt.Sprintf(`{"daily_token_limit":%d,"daily_request_limit":%d}`, tokenLimit, requestLimit)
	return &Channel{Id: id, Setting: &setting}
}

// TestChannelSatisfiesFiltersDailyRequestLimit covers the case the token budget
// cannot: an async image task channel reports no tokens at all.
func TestChannelSatisfiesFiltersDailyRequestLimit(t *testing.T) {
	useDailyLimitFallbackForTest(t)

	channelID := 990010
	channel := channelWithDailyLimits(channelID, 0, 1)

	if ok, kind := ChannelSatisfiesFilters(channel, "test-model", nil); !ok || kind != "" {
		t.Fatalf("fresh channel: ok=%v kind=%q", ok, kind)
	}
	if err := common.IncreaseChannelDailyRequestUsage(channelID); err != nil {
		t.Fatalf("increase request usage: %v", err)
	}
	ok, kind := ChannelSatisfiesFilters(channel, "test-model", nil)
	if ok {
		t.Fatal("channel at its daily request limit must be rejected")
	}
	if kind != dto.FilterDailyRequestLimit {
		t.Fatalf("kind = %q, want %q", kind, dto.FilterDailyRequestLimit)
	}
}

func TestChannelDailyLimitPrecedence(t *testing.T) {
	useDailyLimitFallbackForTest(t)

	channelID := 990011
	channel := channelWithDailyLimits(channelID, 5, 1)
	if err := common.IncreaseChannelDailyTokenUsage(channelID, 5); err != nil {
		t.Fatalf("increase tokens: %v", err)
	}
	if err := common.IncreaseChannelDailyRequestUsage(channelID); err != nil {
		t.Fatalf("increase requests: %v", err)
	}
	// Both budgets are exhausted; the token one is reported first so the
	// attribution stays stable for operators reading the 429.
	if _, kind := ChannelSatisfiesFilters(channel, "test-model", nil); kind != dto.FilterDailyTokenLimit {
		t.Fatalf("kind = %q, want %q", kind, dto.FilterDailyTokenLimit)
	}
	if !IsDailyLimitKind(dto.FilterDailyRequestLimit) {
		t.Fatal("request limit must belong to the daily-limit family")
	}
}

func TestFilterCandidateIDsDailyRequestLimit(t *testing.T) {
	useDailyLimitFallbackForTest(t)

	oldChannels := channelsIDM
	channelsIDM = map[int]*Channel{
		990012: channelWithDailyLimits(990012, 0, 1),
		990013: channelWithDailyLimits(990013, 0, 2),
	}
	t.Cleanup(func() { channelsIDM = oldChannels })

	if err := common.IncreaseChannelDailyRequestUsage(990012); err != nil {
		t.Fatalf("increase requests: %v", err)
	}
	kept, kind := filterCandidateIDs([]int{990012, 990013}, "test-model", nil)
	if len(kept) != 1 || kept[0] != 990013 || kind != "" {
		t.Fatalf("kept=%v kind=%q, want [990013] and empty kind", kept, kind)
	}

	if err := common.IncreaseChannelDailyRequestUsage(990013); err != nil {
		t.Fatalf("increase requests: %v", err)
	}
	if err := common.IncreaseChannelDailyRequestUsage(990013); err != nil {
		t.Fatalf("increase requests: %v", err)
	}
	kept, kind = filterCandidateIDs([]int{990012, 990013}, "test-model", nil)
	if len(kept) != 0 || kind != dto.FilterDailyRequestLimit {
		t.Fatalf("kept=%v kind=%q, want empty and %q", kept, kind, dto.FilterDailyRequestLimit)
	}
}

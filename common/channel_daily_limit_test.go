package common

import (
	"testing"
	"time"
)

func clearChannelDailyTokenFallbackForTest(channelID int) {
	key := channelDailyTokenFallbackKey(channelID, time.Now())
	channelDailyTokenFallbackMu.Lock()
	delete(channelDailyTokenFallbackUsage, key)
	channelDailyTokenFallbackMu.Unlock()
}

func TestChannelDailyTokenUsageFallback(t *testing.T) {
	oldEnabled, oldRDB := RedisEnabled, RDB
	RedisEnabled, RDB = false, nil
	t.Cleanup(func() {
		RedisEnabled, RDB = oldEnabled, oldRDB
	})

	channelID := 990001
	clearChannelDailyTokenFallbackForTest(channelID)
	t.Cleanup(func() { clearChannelDailyTokenFallbackForTest(channelID) })

	if !IsChannelDailyTokenUsageAvailable(channelID, 0) {
		t.Fatal("a zero limit must mean unlimited")
	}
	if err := IncreaseChannelDailyTokenUsage(channelID, 7); err != nil {
		t.Fatalf("increase usage: %v", err)
	}
	if got := GetChannelDailyTokenUsage(channelID); got != 7 {
		t.Fatalf("usage = %d, want 7", got)
	}
	if IsChannelDailyTokenUsageAvailable(channelID, 7) {
		t.Fatal("usage at the limit must be unavailable")
	}
	if !IsChannelDailyTokenUsageAvailable(channelID, 8) {
		t.Fatal("usage below the limit must be available")
	}
	if err := IncreaseChannelDailyTokenUsage(channelID, 5); err != nil {
		t.Fatalf("increase usage again: %v", err)
	}
	if got := GetChannelDailyTokenUsage(channelID); got != 12 {
		t.Fatalf("usage = %d, want 12", got)
	}
}

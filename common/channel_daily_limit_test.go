package common

import (
	"testing"
	"time"
)

func clearChannelDailyFallbackForTest(metric channelDailyMetric, channelID int) {
	key := channelDailyFallbackKey(metric, channelID, time.Now())
	channelDailyFallbackMu.Lock()
	delete(channelDailyFallbackUsage, key)
	channelDailyFallbackMu.Unlock()
}

// withoutRedis forces the in-process fallback path, which is also the only path
// available on a deployment that runs without Redis.
func withoutRedis(t *testing.T) {
	t.Helper()
	oldEnabled, oldRDB := RedisEnabled, RDB
	RedisEnabled, RDB = false, nil
	t.Cleanup(func() {
		RedisEnabled, RDB = oldEnabled, oldRDB
	})
}

func TestChannelDailyTokenUsageFallback(t *testing.T) {
	withoutRedis(t)

	channelID := 990001
	clearChannelDailyFallbackForTest(channelDailyTokenMetric, channelID)
	t.Cleanup(func() { clearChannelDailyFallbackForTest(channelDailyTokenMetric, channelID) })

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
	// Zero-delta writes are ignored so a no-usage response never consumes budget.
	if err := IncreaseChannelDailyTokenUsage(channelID, 0); err != nil {
		t.Fatalf("increase zero: %v", err)
	}
	if got := GetChannelDailyTokenUsage(channelID); got != 12 {
		t.Fatalf("usage after zero delta = %d, want 12", got)
	}
}

func TestChannelDailyRequestUsageFallback(t *testing.T) {
	withoutRedis(t)

	channelID := 990002
	clearChannelDailyFallbackForTest(channelDailyRequestMetric, channelID)
	t.Cleanup(func() { clearChannelDailyFallbackForTest(channelDailyRequestMetric, channelID) })

	if !IsChannelDailyRequestUsageAvailable(channelID, 0) {
		t.Fatal("a zero limit must mean unlimited")
	}
	if !IsChannelDailyRequestUsageAvailable(channelID, -1) {
		t.Fatal("a negative limit must mean unlimited")
	}
	for i := 0; i < 3; i++ {
		if err := IncreaseChannelDailyRequestUsage(channelID); err != nil {
			t.Fatalf("increase request usage: %v", err)
		}
	}
	if got := GetChannelDailyRequestUsage(channelID); got != 3 {
		t.Fatalf("requests = %d, want 3", got)
	}
	if IsChannelDailyRequestUsageAvailable(channelID, 3) {
		t.Fatal("requests at the limit must be unavailable")
	}
	if !IsChannelDailyRequestUsageAvailable(channelID, 4) {
		t.Fatal("requests below the limit must be available")
	}
}

// TestChannelDailyMetricsAreIndependent guards the design premise: async image
// and per-call requests move only the request counter, so capping tokens can
// never be bypassed by them and vice versa.
func TestChannelDailyMetricsAreIndependent(t *testing.T) {
	withoutRedis(t)

	channelID := 990003
	t.Cleanup(func() {
		clearChannelDailyFallbackForTest(channelDailyTokenMetric, channelID)
		clearChannelDailyFallbackForTest(channelDailyRequestMetric, channelID)
	})

	if err := IncreaseChannelDailyRequestUsage(channelID); err != nil {
		t.Fatalf("increase requests: %v", err)
	}
	if got := GetChannelDailyTokenUsage(channelID); got != 0 {
		t.Fatalf("token usage = %d, want 0 (request counting must not move tokens)", got)
	}
	if err := IncreaseChannelDailyTokenUsage(channelID, 40); err != nil {
		t.Fatalf("increase tokens: %v", err)
	}
	if got := GetChannelDailyRequestUsage(channelID); got != 1 {
		t.Fatalf("requests = %d, want 1 (token counting must not move requests)", got)
	}
	if IsChannelDailyTokenUsageAvailable(channelID, 20) {
		t.Fatal("token limit must be reached")
	}
	if !IsChannelDailyRequestUsageAvailable(channelID, 2) {
		t.Fatal("request budget must be unaffected by token usage")
	}
}

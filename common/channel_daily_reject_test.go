package common

import "testing"

// The rejection counter is observability, so it must never move a usage counter:
// enforcement reads the usage counters, and if rejections leaked into them a
// channel would look full without having served anything.
func TestChannelDailyRejectCounterDoesNotMoveUsage(t *testing.T) {
	withoutRedis(t)

	const channelID = 907001
	if got := GetChannelDailyRejectUsage(channelID); got != 0 {
		t.Fatalf("fresh channel should have no rejections, got %d", got)
	}

	for i := 0; i < 2; i++ {
		if err := IncreaseChannelDailyRejectUsage(channelID); err != nil {
			t.Fatalf("IncreaseChannelDailyRejectUsage: %v", err)
		}
	}
	if got := GetChannelDailyRejectUsage(channelID); got != 2 {
		t.Fatalf("expected 2 rejections, got %d", got)
	}
	if got := GetChannelDailyTokenUsage(channelID); got != 0 {
		t.Fatalf("rejections must not add token usage, got %d", got)
	}
	if got := GetChannelDailyRequestUsage(channelID); got != 0 {
		t.Fatalf("rejections must not add request usage, got %d", got)
	}

	// Zero and negative ids are ignored, so a nil channel can never poison a key.
	if err := IncreaseChannelDailyRejectUsage(0); err != nil {
		t.Fatalf("channel id 0 should be a no-op, got %v", err)
	}
	if err := IncreaseChannelDailyRejectUsage(-3); err != nil {
		t.Fatalf("negative channel id should be a no-op, got %v", err)
	}
}

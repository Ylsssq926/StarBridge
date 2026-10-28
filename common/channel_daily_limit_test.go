package common

import (
	"strconv"
	"testing"
	"time"
)

func clearChannelDailyFallbackForTest(metric dailyMetric, channelID int) {
	key := dailyFallbackKey(metric, strconv.Itoa(channelID), time.Now())
	dailyFallbackMu.Lock()
	delete(dailyFallbackUsage, key)
	dailyFallbackMu.Unlock()
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

func clearDailyFallbackSubject(t *testing.T, metric dailyMetric, subject string) {
	t.Helper()
	key := dailyFallbackKey(metric, subject, time.Now())
	dailyFallbackMu.Lock()
	delete(dailyFallbackUsage, key)
	dailyFallbackMu.Unlock()
	t.Cleanup(func() {
		dailyFallbackMu.Lock()
		delete(dailyFallbackUsage, key)
		dailyFallbackMu.Unlock()
	})
}

// A user budget uses the same counter machinery as a channel budget; the only
// difference is that the subject is a user id instead of a channel id.
func TestUserDailyBudgetCounters(t *testing.T) {
	withoutRedis(t)

	const userID = 880001
	clearDailyFallbackSubject(t, userDailyTokenMetric, userDailySubject(userID))
	clearDailyFallbackSubject(t, userDailyRequestMetric, userDailySubject(userID))

	if ok, _ := IsUserDailyBudgetAvailable(userID, 0, 0); !ok {
		t.Fatal("zero budgets must mean unlimited")
	}
	if err := IncreaseUserDailyTokenUsage(userID, 40); err != nil {
		t.Fatalf("increase tokens: %v", err)
	}
	if err := IncreaseUserDailyRequestUsage(userID); err != nil {
		t.Fatalf("increase requests: %v", err)
	}
	if got := GetUserDailyTokenUsage(userID); got != 40 {
		t.Fatalf("token usage = %d, want 40", got)
	}
	if got := GetUserDailyRequestUsage(userID); got != 1 {
		t.Fatalf("request usage = %d, want 1", got)
	}
	if ok, metric := IsUserDailyBudgetAvailable(userID, 40, 10); ok || metric != "token" {
		t.Fatalf("token budget at limit: ok=%v metric=%q, want false/token", ok, metric)
	}
	if ok, metric := IsUserDailyBudgetAvailable(userID, 100, 1); ok || metric != "request" {
		t.Fatalf("request budget at limit: ok=%v metric=%q, want false/request", ok, metric)
	}
	if ok, _ := IsUserDailyBudgetAvailable(userID, 100, 2); !ok {
		t.Fatal("budgets above usage must be available")
	}
}

// Group budgets share the counters too; the subject is the group name, so this
// also proves non-numeric subjects work end to end.
func TestGroupDailyBudgetCounters(t *testing.T) {
	withoutRedis(t)

	const group = "verify-group"
	clearDailyFallbackSubject(t, groupDailyTokenMetric, group)
	clearDailyFallbackSubject(t, groupDailyRequestMetric, group)

	if err := IncreaseGroupDailyTokenUsage(group, 12); err != nil {
		t.Fatalf("increase group tokens: %v", err)
	}
	if err := IncreaseGroupDailyRequestUsage(group); err != nil {
		t.Fatalf("increase group requests: %v", err)
	}
	if got := GetGroupDailyTokenUsage(group); got != 12 {
		t.Fatalf("group token usage = %d, want 12", got)
	}
	if ok, metric := IsGroupDailyBudgetAvailable(group, 12, 0); ok || metric != "token" {
		t.Fatalf("group token budget at limit: ok=%v metric=%q", ok, metric)
	}
	if ok, _ := IsGroupDailyBudgetAvailable("another-group", 1, 1); !ok {
		t.Fatal("an untouched group must be available")
	}
}

func TestGroupDailyBudgetOptionParsing(t *testing.T) {
	oldMap := OptionMap
	t.Cleanup(func() { OptionMap = oldMap })

	OptionMap = map[string]string{GroupDailyBudgetOptionKey: `{"vip":{"token":100,"request":5},"empty":{}}`}
	if got := GetGroupDailyBudget("vip"); got.Token != 100 || got.Request != 5 {
		t.Fatalf("vip budget = %+v, want {100 5}", got)
	}
	if got := GetGroupDailyBudget("empty"); got.Token != 0 || got.Request != 0 {
		t.Fatalf("empty budget = %+v, want zero", got)
	}
	if got := GetGroupDailyBudget("unknown"); got.Token != 0 || got.Request != 0 {
		t.Fatalf("unknown group = %+v, want zero (unlimited)", got)
	}

	// A malformed option must degrade to "unlimited", never to a random limit.
	OptionMap = map[string]string{GroupDailyBudgetOptionKey: `{not json`}
	if got := GetGroupDailyBudget("vip"); got.Token != 0 || got.Request != 0 {
		t.Fatalf("malformed option = %+v, want zero", got)
	}

	// The cache is keyed by the raw option string, so an update is picked up.
	OptionMap = map[string]string{GroupDailyBudgetOptionKey: `{"vip":{"token":7}}`}
	if got := GetGroupDailyBudget("vip"); got.Token != 7 {
		t.Fatalf("after update vip budget = %+v, want token 7", got)
	}
}

package common

import (
	"errors"
	"fmt"
	"strconv"
	"sync"
	"time"

	"github.com/QuantumNous/new-api/constant"
	"github.com/go-redis/redis/v8"
)

// channelDailyMetric names one per-day counter maintained per channel. Two
// usage metrics are tracked because they cover different upstream realities:
// tokens for text relay, requests for async tasks and per-call priced work.
// The third metric counts budget rejections and is observability only.
type channelDailyMetric struct {
	name          string // fallback-key namespace and log wording
	keyFmt        string // Redis key format: channel id, then date
	redisDisabled string // one-shot warning text
	failureHint   string // what going wrong means, per metric
}

var (
	channelDailyTokenMetric = channelDailyMetric{
		name:          "tokens",
		keyFmt:        constant.ChannelDailyTokenUsageKeyFmt,
		redisDisabled: "Redis is disabled; channel daily token usage falls back to in-process memory and is not consistent across multiple instances",
		failureHint:   "daily limit may not take effect across instances",
	}
	channelDailyRequestMetric = channelDailyMetric{
		name:          "requests",
		keyFmt:        constant.ChannelDailyRequestUsageKeyFmt,
		redisDisabled: "Redis is disabled; channel daily request usage falls back to in-process memory and is not consistent across multiple instances",
		failureHint:   "daily limit may not take effect across instances",
	}
	channelDailyRejectMetric = channelDailyMetric{
		name:          "rejects",
		keyFmt:        constant.ChannelDailyRejectUsageKeyFmt,
		redisDisabled: "Redis is disabled; channel daily rejection counts fall back to in-process memory and only cover this instance",
		failureHint:   "rejection counts may be under-reported across instances",
	}
)

var (
	channelDailyFallbackMu       sync.Mutex
	channelDailyFallbackUsage    = map[string]int64{}
	channelDailyFallbackCleanup  sync.Once
	channelDailyRedisDisabledLog sync.Map // metric name -> bool
)

func channelDailyDate(t time.Time) string {
	return t.Format("20060102")
}

func channelDailyNextMidnight(t time.Time) time.Time {
	return time.Date(t.Year(), t.Month(), t.Day()+1, 0, 0, 0, 0, t.Location())
}

func channelDailyRedisKey(metric channelDailyMetric, channelID int, t time.Time) string {
	return fmt.Sprintf(metric.keyFmt, channelID, channelDailyDate(t))
}

func channelDailyFallbackKey(metric channelDailyMetric, channelID int, t time.Time) string {
	return fmt.Sprintf("%s:%d:%s", metric.name, channelID, channelDailyDate(t))
}

func logChannelDailyRedisDisabled(metric channelDailyMetric) {
	if _, loaded := channelDailyRedisDisabledLog.LoadOrStore(metric.name, true); loaded {
		return
	}
	SysLog(metric.redisDisabled)
}

func startChannelDailyFallbackCleanup() {
	channelDailyFallbackCleanup.Do(func() {
		go func() {
			ticker := time.NewTicker(time.Minute)
			defer ticker.Stop()
			for range ticker.C {
				currentDate := channelDailyDate(time.Now())
				channelDailyFallbackMu.Lock()
				for key := range channelDailyFallbackUsage {
					if len(key) < len(currentDate) || key[len(key)-len(currentDate):] != currentDate {
						delete(channelDailyFallbackUsage, key)
					}
				}
				channelDailyFallbackMu.Unlock()
			}
		}()
	})
}

func getChannelDailyFallbackUsage(metric channelDailyMetric, channelID int, now time.Time) int64 {
	key := channelDailyFallbackKey(metric, channelID, now)
	channelDailyFallbackMu.Lock()
	defer channelDailyFallbackMu.Unlock()
	return channelDailyFallbackUsage[key]
}

func addChannelDailyFallbackUsage(metric channelDailyMetric, channelID int, delta int64, now time.Time) {
	key := channelDailyFallbackKey(metric, channelID, now)
	channelDailyFallbackMu.Lock()
	channelDailyFallbackUsage[key] += delta
	channelDailyFallbackMu.Unlock()
}

// getChannelDailyUsage returns today's usage for a metric. Usage written while
// Redis was unavailable is kept in-process and added to the Redis value, so a
// Redis outage never resets a channel's day.
func getChannelDailyUsage(metric channelDailyMetric, channelID int) int64 {
	now := time.Now()
	fallbackUsage := getChannelDailyFallbackUsage(metric, channelID, now)
	if RedisEnabled && RDB != nil {
		value, err := RedisGet(channelDailyRedisKey(metric, channelID, now))
		if errors.Is(err, redis.Nil) {
			return fallbackUsage
		}
		if err != nil {
			SysError(fmt.Sprintf("failed to get channel daily %s usage from Redis: channel_id=%d, error=%v", metric.name, channelID, err))
			return fallbackUsage
		}
		usage, err := strconv.ParseInt(value, 10, 64)
		if err != nil {
			SysError(fmt.Sprintf("failed to parse channel daily %s usage: channel_id=%d, value=%s, error=%v", metric.name, channelID, value, err))
			return fallbackUsage
		}
		return usage + fallbackUsage
	}

	logChannelDailyRedisDisabled(metric)
	startChannelDailyFallbackCleanup()
	return fallbackUsage
}

// increaseChannelDailyUsage records usage for the current day. It returns the
// Redis error when the shared counter could not be written; the in-process
// fallback is always applied so a single instance still enforces the cap.
func increaseChannelDailyUsage(metric channelDailyMetric, channelID int, delta int64) error {
	if channelID <= 0 || delta <= 0 {
		return nil
	}

	now := time.Now()
	if RedisEnabled && RDB != nil {
		expireAt := channelDailyNextMidnight(now)
		_, err := RedisIncrByWithExpireAt(channelDailyRedisKey(metric, channelID, now), delta, expireAt)
		if err != nil {
			startChannelDailyFallbackCleanup()
			addChannelDailyFallbackUsage(metric, channelID, delta, now)
			fallbackErr := fmt.Errorf("channel daily %s usage NOT recorded in Redis (%s): channel_id=%d, delta=%d, error=%w", metric.name, metric.failureHint, channelID, delta, err)
			SysError(fallbackErr.Error())
			return fallbackErr
		}
		return nil
	}

	logChannelDailyRedisDisabled(metric)
	startChannelDailyFallbackCleanup()
	addChannelDailyFallbackUsage(metric, channelID, delta, now)
	return nil
}

func isChannelDailyUsageAvailable(metric channelDailyMetric, channelID int, limit int64) bool {
	if limit <= 0 {
		return true
	}
	return getChannelDailyUsage(metric, channelID) < limit
}

// GetChannelDailyTokenUsage returns today's billable token usage for a channel.
func GetChannelDailyTokenUsage(channelID int) int64 {
	return getChannelDailyUsage(channelDailyTokenMetric, channelID)
}

// IsChannelDailyTokenUsageAvailable reports whether the channel may still serve
// tokens today. A non-positive limit means unlimited.
func IsChannelDailyTokenUsageAvailable(channelID int, limit int64) bool {
	return isChannelDailyUsageAvailable(channelDailyTokenMetric, channelID, limit)
}

// IncreaseChannelDailyTokenUsage records billable tokens for the current day.
func IncreaseChannelDailyTokenUsage(channelID int, tokens int64) error {
	return increaseChannelDailyUsage(channelDailyTokenMetric, channelID, tokens)
}

// GetChannelDailyRequestUsage returns today's billable request count for a channel.
func GetChannelDailyRequestUsage(channelID int) int64 {
	return getChannelDailyUsage(channelDailyRequestMetric, channelID)
}

// IsChannelDailyRequestUsageAvailable reports whether the channel may still take
// requests today. A non-positive limit means unlimited.
func IsChannelDailyRequestUsageAvailable(channelID int, limit int64) bool {
	return isChannelDailyUsageAvailable(channelDailyRequestMetric, channelID, limit)
}

// IncreaseChannelDailyRequestUsage records one billable request for the current day.
func IncreaseChannelDailyRequestUsage(channelID int) error {
	return increaseChannelDailyUsage(channelDailyRequestMetric, channelID, 1)
}

// GetChannelDailyRejectUsage returns how many times a live request skipped this
// channel today because a per-day budget was already exhausted.
func GetChannelDailyRejectUsage(channelID int) int64 {
	return getChannelDailyUsage(channelDailyRejectMetric, channelID)
}

// IncreaseChannelDailyRejectUsage counts one budget rejection for the current
// day. Losing this counter (Redis flush, restart, another instance) only affects
// the reported number, never enforcement.
func IncreaseChannelDailyRejectUsage(channelID int) error {
	return increaseChannelDailyUsage(channelDailyRejectMetric, channelID, 1)
}

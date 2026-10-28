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

// dailyMetric names one per-day counter maintained per channel. Two
// usage metrics are tracked because they cover different upstream realities:
// tokens for text relay, requests for async tasks and per-call priced work.
// The third metric counts budget rejections and is observability only.
type dailyMetric struct {
	name          string // fallback-key namespace and log wording
	keyFmt        string // Redis key format: channel id, then date
	redisDisabled string // one-shot warning text
	failureHint   string // what going wrong means, per metric
}

var (
	channelDailyTokenMetric = dailyMetric{
		name:          "tokens",
		keyFmt:        constant.ChannelDailyTokenUsageKeyFmt,
		redisDisabled: "Redis is disabled; channel daily token usage falls back to in-process memory and is not consistent across multiple instances",
		failureHint:   "daily limit may not take effect across instances",
	}
	channelDailyRequestMetric = dailyMetric{
		name:          "requests",
		keyFmt:        constant.ChannelDailyRequestUsageKeyFmt,
		redisDisabled: "Redis is disabled; channel daily request usage falls back to in-process memory and is not consistent across multiple instances",
		failureHint:   "daily limit may not take effect across instances",
	}
	channelDailyRejectMetric = dailyMetric{
		name:          "rejects",
		keyFmt:        constant.ChannelDailyRejectUsageKeyFmt,
		redisDisabled: "Redis is disabled; channel daily rejection counts fall back to in-process memory and only cover this instance",
		failureHint:   "rejection counts may be under-reported across instances",
	}
)

var (
	dailyFallbackMu       sync.Mutex
	dailyFallbackUsage    = map[string]int64{}
	dailyFallbackCleanup  sync.Once
	dailyRedisDisabledLog sync.Map // metric name -> bool
)

func dailyDate(t time.Time) string {
	return t.Format("20060102")
}

func dailyNextMidnight(t time.Time) time.Time {
	return time.Date(t.Year(), t.Month(), t.Day()+1, 0, 0, 0, 0, t.Location())
}

func dailyRedisKey(metric dailyMetric, subject string, t time.Time) string {
	return fmt.Sprintf(metric.keyFmt, subject, dailyDate(t))
}

func dailyFallbackKey(metric dailyMetric, subject string, t time.Time) string {
	return fmt.Sprintf("%s:%s:%s", metric.name, subject, dailyDate(t))
}

func logDailyRedisDisabled(metric dailyMetric) {
	if _, loaded := dailyRedisDisabledLog.LoadOrStore(metric.name, true); loaded {
		return
	}
	SysLog(metric.redisDisabled)
}

func startDailyFallbackCleanup() {
	dailyFallbackCleanup.Do(func() {
		go func() {
			ticker := time.NewTicker(time.Minute)
			defer ticker.Stop()
			for range ticker.C {
				currentDate := dailyDate(time.Now())
				dailyFallbackMu.Lock()
				for key := range dailyFallbackUsage {
					if len(key) < len(currentDate) || key[len(key)-len(currentDate):] != currentDate {
						delete(dailyFallbackUsage, key)
					}
				}
				dailyFallbackMu.Unlock()
			}
		}()
	})
}

func getDailyFallbackUsage(metric dailyMetric, subject string, now time.Time) int64 {
	key := dailyFallbackKey(metric, subject, now)
	dailyFallbackMu.Lock()
	defer dailyFallbackMu.Unlock()
	return dailyFallbackUsage[key]
}

func addDailyFallbackUsage(metric dailyMetric, subject string, delta int64, now time.Time) {
	key := dailyFallbackKey(metric, subject, now)
	dailyFallbackMu.Lock()
	dailyFallbackUsage[key] += delta
	dailyFallbackMu.Unlock()
}

// getDailyUsage returns today's usage for a metric. Usage written while
// Redis was unavailable is kept in-process and added to the Redis value, so a
// Redis outage never resets a channel's day.
func getDailyUsage(metric dailyMetric, subject string) int64 {
	now := time.Now()
	fallbackUsage := getDailyFallbackUsage(metric, subject, now)
	if RedisEnabled && RDB != nil {
		value, err := RedisGet(dailyRedisKey(metric, subject, now))
		if errors.Is(err, redis.Nil) {
			return fallbackUsage
		}
		if err != nil {
			SysError(fmt.Sprintf("failed to get daily %s usage from Redis: subject=%s, error=%v", metric.name, subject, err))
			return fallbackUsage
		}
		usage, err := strconv.ParseInt(value, 10, 64)
		if err != nil {
			SysError(fmt.Sprintf("failed to parse daily %s usage: subject=%s, value=%s, error=%v", metric.name, subject, value, err))
			return fallbackUsage
		}
		return usage + fallbackUsage
	}

	logDailyRedisDisabled(metric)
	startDailyFallbackCleanup()
	return fallbackUsage
}

// increaseDailyUsage records usage for the current day. It returns the
// Redis error when the shared counter could not be written; the in-process
// fallback is always applied so a single instance still enforces the cap.
func increaseDailyUsage(metric dailyMetric, subject string, delta int64) error {
	if subject == "" || delta <= 0 {
		return nil
	}

	now := time.Now()
	if RedisEnabled && RDB != nil {
		expireAt := dailyNextMidnight(now)
		_, err := RedisIncrByWithExpireAt(dailyRedisKey(metric, subject, now), delta, expireAt)
		if err != nil {
			startDailyFallbackCleanup()
			addDailyFallbackUsage(metric, subject, delta, now)
			fallbackErr := fmt.Errorf("daily %s usage NOT recorded in Redis (%s): subject=%s, delta=%d, error=%w", metric.name, metric.failureHint, subject, delta, err)
			SysError(fallbackErr.Error())
			return fallbackErr
		}
		return nil
	}

	logDailyRedisDisabled(metric)
	startDailyFallbackCleanup()
	addDailyFallbackUsage(metric, subject, delta, now)
	return nil
}

func isDailyUsageAvailable(metric dailyMetric, subject string, limit int64) bool {
	if limit <= 0 {
		return true
	}
	return getDailyUsage(metric, subject) < limit
}

// GetChannelDailyTokenUsage returns today's billable token usage for a channel.
func GetChannelDailyTokenUsage(channelID int) int64 {
	return getDailyUsage(channelDailyTokenMetric, strconv.Itoa(channelID))
}

// IsChannelDailyTokenUsageAvailable reports whether the channel may still serve
// tokens today. A non-positive limit means unlimited.
func IsChannelDailyTokenUsageAvailable(channelID int, limit int64) bool {
	return isDailyUsageAvailable(channelDailyTokenMetric, strconv.Itoa(channelID), limit)
}

// IncreaseChannelDailyTokenUsage records billable tokens for the current day.
func IncreaseChannelDailyTokenUsage(channelID int, tokens int64) error {
	return increaseDailyUsage(channelDailyTokenMetric, strconv.Itoa(channelID), tokens)
}

// GetChannelDailyRequestUsage returns today's billable request count for a channel.
func GetChannelDailyRequestUsage(channelID int) int64 {
	return getDailyUsage(channelDailyRequestMetric, strconv.Itoa(channelID))
}

// IsChannelDailyRequestUsageAvailable reports whether the channel may still take
// requests today. A non-positive limit means unlimited.
func IsChannelDailyRequestUsageAvailable(channelID int, limit int64) bool {
	return isDailyUsageAvailable(channelDailyRequestMetric, strconv.Itoa(channelID), limit)
}

// IncreaseChannelDailyRequestUsage records one billable request for the current day.
func IncreaseChannelDailyRequestUsage(channelID int) error {
	return increaseDailyUsage(channelDailyRequestMetric, strconv.Itoa(channelID), 1)
}

// GetChannelDailyRejectUsage returns how many times a live request skipped this
// channel today because a per-day budget was already exhausted.
func GetChannelDailyRejectUsage(channelID int) int64 {
	return getDailyUsage(channelDailyRejectMetric, strconv.Itoa(channelID))
}

// IncreaseChannelDailyRejectUsage counts one budget rejection for the current
// day. Losing this counter (Redis flush, restart, another instance) only affects
// the reported number, never enforcement.
func IncreaseChannelDailyRejectUsage(channelID int) error {
	return increaseDailyUsage(channelDailyRejectMetric, strconv.Itoa(channelID), 1)
}

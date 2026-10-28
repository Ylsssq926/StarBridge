package common

import (
	"fmt"
	"strconv"
	"sync"
	"time"

	"github.com/QuantumNous/new-api/constant"
)

// Per-key pacing is what keeps a subscription account from being hammered: a
// request rate limit the operator sets per key, a short self-expiring cooldown
// after the upstream answers 429, and a "same client keeps the same key" binding
// so a conversation does not hop accounts. None of it touches the channel status
// (that stays a human/auto-disable decision); all of it expires on its own.

const (
	keyRPMWindowSeconds = int64(60)
	// DefaultKeyRateLimitCooldownSeconds is how long a key rests after an
	// upstream 429 when the option is unset.
	DefaultKeyRateLimitCooldownSeconds = 60
	// MaxKeyRateLimitCooldownSeconds keeps a pathological Retry-After or a typo
	// from parking a key for hours.
	MaxKeyRateLimitCooldownSeconds = 600
	// DefaultKeyAffinityTTLSeconds is how long a client stays bound to the key
	// that last served it successfully.
	DefaultKeyAffinityTTLSeconds = 600
)

var keyRPMLimiter InMemoryRateLimiter

func keyRPMLimiterAllows(channelID, keyIndex, limit int) bool {
	keyRPMLimiter.Init(2 * time.Minute)
	return keyRPMLimiter.Request(fmt.Sprintf("key_rpm:%d:%d", channelID, keyIndex), limit, keyRPMWindowSeconds)
}

// IsKeyRPMAllowed records one admission against a key's per-minute limit and
// reports whether it is still inside the budget. A non-positive limit means
// unlimited. With Redis the fixed window (reset every minute) is shared by every
// instance; without it the in-process sliding window is used and only applies to
// this instance.
func IsKeyRPMAllowed(channelID, keyIndex, limit int) bool {
	if limit <= 0 {
		return true
	}
	if channelID <= 0 || keyIndex < 0 {
		return true
	}
	if RedisEnabled && RDB != nil {
		now := time.Now()
		window := now.Unix() - now.Unix()%keyRPMWindowSeconds
		key := fmt.Sprintf(constant.KeyRPMWindowKeyFmt, channelID, keyIndex, window)
		// Keep the window key a little past its reset so a clock skew on another
		// instance cannot read a vanished key as "no traffic yet".
		count, err := RedisIncrByWithExpireAt(key, 1, now.Add(2*time.Second*time.Duration(keyRPMWindowSeconds)))
		if err == nil {
			return count <= int64(limit)
		}
		SysError(fmt.Sprintf("per-key RPM not recorded in Redis, falling back to in-process: channel=%d key=%d error=%v", channelID, keyIndex, err))
	}
	return keyRPMLimiterAllows(channelID, keyIndex, limit)
}

var keyCooldownFallback = struct {
	sync.Mutex
	until map[string]int64
}{until: make(map[string]int64)}

func keyCooldownFallbackKey(channelID, keyIndex int) string {
	return fmt.Sprintf("%d:%d", channelID, keyIndex)
}

// SetKeyCooldown parks one key for a few seconds after the upstream rate-limited
// it. Zero or negative means "do nothing"; the value is clamped to the maximum.
func SetKeyCooldown(channelID, keyIndex int, seconds int64) {
	if channelID <= 0 || keyIndex < 0 || seconds <= 0 {
		return
	}
	seconds = min(seconds, int64(MaxKeyRateLimitCooldownSeconds))
	until := time.Now().Unix() + seconds
	if RedisEnabled && RDB != nil {
		key := fmt.Sprintf(constant.KeyCooldownKeyFmt, channelID, keyIndex)
		if err := RedisSet(key, strconv.FormatInt(until, 10), time.Duration(seconds)*time.Second); err == nil {
			return
		}
		SysError(fmt.Sprintf("per-key cooldown not stored in Redis, falling back to in-process: channel=%d key=%d", channelID, keyIndex))
	}
	keyCooldownFallback.Lock()
	keyCooldownFallback.until[keyCooldownFallbackKey(channelID, keyIndex)] = until
	keyCooldownFallback.Unlock()
}

// KeyCooldownRemainingSeconds reports how long the key should still be skipped.
func KeyCooldownRemainingSeconds(channelID, keyIndex int) int64 {
	if channelID <= 0 || keyIndex < 0 {
		return 0
	}
	now := time.Now().Unix()
	if RedisEnabled && RDB != nil {
		key := fmt.Sprintf(constant.KeyCooldownKeyFmt, channelID, keyIndex)
		value, err := RedisGet(key)
		if err == nil {
			until, parseErr := strconv.ParseInt(value, 10, 64)
			if parseErr == nil {
				return max(0, until-now)
			}
			SysError("failed to parse per-key cooldown value: " + parseErr.Error())
		}
	}
	keyCooldownFallback.Lock()
	defer keyCooldownFallback.Unlock()
	fallbackKey := keyCooldownFallbackKey(channelID, keyIndex)
	until, ok := keyCooldownFallback.until[fallbackKey]
	if !ok {
		return 0
	}
	if until <= now {
		delete(keyCooldownFallback.until, fallbackKey)
		return 0
	}
	return until - now
}

var keyAffinityFallback = struct {
	sync.Mutex
	bindings map[string]keyAffinityBinding
}{bindings: make(map[string]keyAffinityBinding)}

type keyAffinityBinding struct {
	keyIndex int
	until    int64
}

func keyAffinitySubject(tokenID, channelID int, modelName string) string {
	return fmt.Sprintf(constant.KeyAffinityKeyFmt, tokenID, channelID, modelName)
}

// SetKeyAffinity binds a client (token + channel + model) to the key that just
// served it. Non-positive TTL disables the binding.
func SetKeyAffinity(tokenID, channelID int, modelName string, keyIndex int, ttlSeconds int64) {
	if tokenID <= 0 || channelID <= 0 || modelName == "" || keyIndex < 0 || ttlSeconds <= 0 {
		return
	}
	subject := keyAffinitySubject(tokenID, channelID, modelName)
	if RedisEnabled && RDB != nil {
		if err := RedisSet(subject, strconv.Itoa(keyIndex), time.Duration(ttlSeconds)*time.Second); err == nil {
			return
		}
		SysError("per-key affinity not stored in Redis, falling back to in-process: " + modelName)
	}
	keyAffinityFallback.Lock()
	keyAffinityFallback.bindings[subject] = keyAffinityBinding{keyIndex: keyIndex, until: time.Now().Unix() + ttlSeconds}
	keyAffinityFallback.Unlock()
}

// GetKeyAffinity returns the key bound to this client, if the binding is still
// valid and belongs to this channel.
func GetKeyAffinity(tokenID, channelID int, modelName string) (int, bool) {
	if tokenID <= 0 || channelID <= 0 || modelName == "" {
		return 0, false
	}
	subject := keyAffinitySubject(tokenID, channelID, modelName)
	if RedisEnabled && RDB != nil {
		value, err := RedisGet(subject)
		if err == nil {
			keyIndex, parseErr := strconv.Atoi(value)
			if parseErr == nil && keyIndex >= 0 {
				return keyIndex, true
			}
		}
	}
	keyAffinityFallback.Lock()
	defer keyAffinityFallback.Unlock()
	binding, ok := keyAffinityFallback.bindings[subject]
	if !ok {
		return 0, false
	}
	if binding.until <= time.Now().Unix() {
		delete(keyAffinityFallback.bindings, subject)
		return 0, false
	}
	return binding.keyIndex, true
}

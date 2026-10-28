package service

import (
	"net/http"
	"strconv"

	"github.com/QuantumNous/new-api/common"
	"github.com/QuantumNous/new-api/constant"
	"github.com/QuantumNous/new-api/model"
	relaycommon "github.com/QuantumNous/new-api/relay/common"
	"github.com/QuantumNous/new-api/relaykit/types"

	"github.com/gin-gonic/gin"
)

const (
	// KeyRateLimitCooldownOptionKey is how many seconds a key rests after the
	// upstream answered 429. 0 disables the cooldown (the key stays selectable).
	KeyRateLimitCooldownOptionKey = "KeyRateLimitCooldownSeconds"
	// KeyAffinityTTLOptionKey is how long a client stays bound to the key that
	// last served it. 0 disables key affinity.
	KeyAffinityTTLOptionKey = "KeyAffinityTTLSeconds"
)

func optionInt(key string, fallback int) int {
	raw := ""
	if common.OptionMap != nil {
		raw = common.OptionMap[key]
	}
	if raw == "" {
		return fallback
	}
	value, err := strconv.Atoi(raw)
	if err != nil {
		common.SysError("invalid " + key + " option, falling back to " + strconv.Itoa(fallback) + ": " + err.Error())
		return fallback
	}
	return value
}

// keyRPMLimit returns the per-minute request cap configured for one key index.
func keyRPMLimit(channel *model.Channel, keyIndex int) int64 {
	if channel == nil {
		return 0
	}
	setting := channel.GetSetting()
	if setting.KeyRPMLimits == nil {
		return 0
	}
	return setting.KeyRPMLimits[strconv.Itoa(keyIndex)]
}

func keyRateLimitCooldownSeconds() int64 {
	seconds := optionInt(KeyRateLimitCooldownOptionKey, common.DefaultKeyRateLimitCooldownSeconds)
	if seconds <= 0 {
		return 0
	}
	return int64(min(seconds, common.MaxKeyRateLimitCooldownSeconds))
}

func keyAffinityTTLSeconds() int64 {
	seconds := optionInt(KeyAffinityTTLOptionKey, common.DefaultKeyAffinityTTLSeconds)
	if seconds <= 0 {
		return 0
	}
	return int64(seconds)
}

// MarkKeyRateLimited rests the key that just received an upstream 429 instead of
// hammering it again. Only multi-key channels have a stable key index; the
// channel status is deliberately untouched — a 429 is "slow down", not "broken".
func MarkKeyRateLimited(relayInfo *relaycommon.RelayInfo, err *types.NewAPIError) {
	if relayInfo == nil || !relayInfo.ChannelIsMultiKey || err == nil {
		return
	}
	if err.StatusCode != http.StatusTooManyRequests {
		return
	}
	seconds := err.RetryAfterSeconds()
	if seconds <= 0 {
		seconds = keyRateLimitCooldownSeconds()
	}
	if seconds <= 0 {
		return
	}
	seconds = min(seconds, int64(common.MaxKeyRateLimitCooldownSeconds))
	common.SetKeyCooldown(relayInfo.ChannelId, relayInfo.ChannelMultiKeyIndex, seconds)
	common.SysLog(common.LogText("multi-key channel #%d: key #%d cooled down for %d seconds after upstream 429", relayInfo.ChannelId, relayInfo.ChannelMultiKeyIndex, seconds))
}

// RecordKeyAffinity binds this client to the key that successfully served it, so
// follow-up requests do not hop accounts. The binding is advisory: selection
// falls back to the normal pool when the key is unavailable.
func RecordKeyAffinity(c *gin.Context, channelID int) {
	if c == nil || channelID <= 0 {
		return
	}
	if !common.GetContextKeyBool(c, constant.ContextKeyChannelIsMultiKey) {
		return
	}
	ttl := keyAffinityTTLSeconds()
	if ttl <= 0 {
		return
	}
	tokenID := common.GetContextKeyInt(c, constant.ContextKeyTokenId)
	if tokenID <= 0 {
		return
	}
	modelName := c.GetString("original_model")
	keyIndex := common.GetContextKeyInt(c, constant.ContextKeyChannelMultiKeyIndex)
	common.SetKeyAffinity(tokenID, channelID, modelName, keyIndex, ttl)
}

// keyAffinityPreference returns the bound key index for this request, if any.
func keyAffinityPreference(c *gin.Context, channel *model.Channel) (int, bool) {
	if c == nil || channel == nil {
		return 0, false
	}
	if keyAffinityTTLSeconds() <= 0 {
		return 0, false
	}
	tokenID := common.GetContextKeyInt(c, constant.ContextKeyTokenId)
	if tokenID <= 0 {
		return 0, false
	}
	return common.GetKeyAffinity(tokenID, channel.Id, c.GetString("original_model"))
}

// keyAdmits reports whether one specific key may serve right now, and whether a
// rejection was caused by pacing (cooldown / RPM) rather than budget or status.
// An admitted key has already consumed its RPM slot.
func keyAdmits(channel *model.Channel, keyIndex int) (admitted bool, rateLimited bool) {
	keys := channel.GetKeys()
	if keyIndex < 0 || keyIndex >= len(keys) {
		return false, false
	}
	status := common.ChannelStatusEnabled
	if channel.ChannelInfo.MultiKeyStatusList != nil {
		if recorded, ok := channel.ChannelInfo.MultiKeyStatusList[keyIndex]; ok {
			status = recorded
		}
	}
	if status != common.ChannelStatusEnabled {
		return false, false
	}
	if common.KeyCooldownRemainingSeconds(channel.Id, keyIndex) > 0 {
		return false, true
	}
	tokenLimit, requestLimit := keyDailyBudget(channel, keyIndex)
	if !common.IsKeyDailyBudgetAvailable(channel.Id, keyIndex, tokenLimit, requestLimit) {
		return false, false
	}
	if !common.IsKeyRPMAllowed(channel.Id, keyIndex, int(keyRPMLimit(channel, keyIndex))) {
		return false, true
	}
	return true, false
}

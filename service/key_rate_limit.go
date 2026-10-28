package service

import (
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/QuantumNous/new-api/common"
	"github.com/QuantumNous/new-api/constant"
	"github.com/QuantumNous/new-api/model"
	relaycommon "github.com/QuantumNous/new-api/relay/common"
	"github.com/QuantumNous/new-api/relaykit/dto"
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
func keyRPMLimit(setting dto.ChannelSettings, keyIndex int) int64 {
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

// Capacity 429s mean the model is overloaded for everyone, not that this
// credential misbehaved. Cooling the key would shrink the pool for an upstream
// problem, so these markers skip the cooldown and let the next request try.
var capacityRateLimitMarkers = []string{
	"model_temporarily_unavailable",
	"model temporarily unavailable",
	"temporarily unavailable",
	"insufficient_model_capacity",
	"insufficient model capacity",
	"model is overloaded",
	"overloaded_error",
	"overloaded",
}

func isCapacityRateLimit(err *types.NewAPIError) bool {
	text := strings.ToLower(err.Error())
	for _, marker := range capacityRateLimitMarkers {
		if strings.Contains(text, marker) {
			return true
		}
	}
	return false
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
	if isCapacityRateLimit(err) {
		common.SysLog(common.LogText("multi-key channel #%d: key #%d hit a capacity limit (not account throttling); no cooldown applied", relayInfo.ChannelId, relayInfo.ChannelMultiKeyIndex))
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

type keyRejection int

const (
	keyAccepted keyRejection = iota
	keyRejectedStatus
	keyRejectedBudget
	keyRejectedPacing
	keyRejectedExternal
)

// externalKeyStateBlocks reports whether an outside controller (the sidecar that
// owns the accounts) marked this key as unavailable. Expired entries are normal
// again without a write: until is a timestamp, not a flag.
func externalKeyStateBlocks(setting dto.ChannelSettings, keyIndex int) bool {
	if setting.KeyExternalStates == nil {
		return false
	}
	state, ok := setting.KeyExternalStates[strconv.Itoa(keyIndex)]
	if !ok || state.State == "" || state.State == "normal" {
		return false
	}
	return state.Until <= 0 || state.Until > time.Now().Unix()
}

// keyAdmits reports whether one specific key may serve right now and why not.
// An admitted key has already consumed its RPM slot.
func keyAdmits(channel *model.Channel, setting dto.ChannelSettings, keyIndex int) (bool, keyRejection) {
	keys := channel.GetKeys()
	if keyIndex < 0 || keyIndex >= len(keys) {
		return false, keyRejectedStatus
	}
	status := common.ChannelStatusEnabled
	if channel.ChannelInfo.MultiKeyStatusList != nil {
		if recorded, ok := channel.ChannelInfo.MultiKeyStatusList[keyIndex]; ok {
			status = recorded
		}
	}
	if status != common.ChannelStatusEnabled {
		return false, keyRejectedStatus
	}
	if externalKeyStateBlocks(setting, keyIndex) {
		return false, keyRejectedExternal
	}
	if common.KeyCooldownRemainingSeconds(channel.Id, keyIndex) > 0 {
		return false, keyRejectedPacing
	}
	tokenLimit, requestLimit := keyDailyBudget(setting, keyIndex)
	if !common.IsKeyDailyBudgetAvailable(channel.Id, keyIndex, tokenLimit, requestLimit) {
		return false, keyRejectedBudget
	}
	if !common.IsKeyRPMAllowed(channel.Id, keyIndex, int(keyRPMLimit(setting, keyIndex))) {
		return false, keyRejectedPacing
	}
	return true, keyAccepted
}

// RecordKeyFailure counts one upstream failure against the key that produced it.
// It answers "is this credential flaky?" without querying the log database.
func RecordKeyFailure(relayInfo *relaycommon.RelayInfo, err *types.NewAPIError) {
	if relayInfo == nil || !relayInfo.ChannelIsMultiKey || err == nil {
		return
	}
	if err.StatusCode > 0 && err.StatusCode < 400 {
		return
	}
	if incErr := common.IncreaseKeyDailyFailureCount(relayInfo.ChannelId, relayInfo.ChannelMultiKeyIndex); incErr != nil {
		common.SysError("per-key failure count not recorded: " + incErr.Error())
	}
}

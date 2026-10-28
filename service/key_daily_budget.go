package service

import (
	"errors"
	"net/http"
	"strconv"
	"time"

	"github.com/QuantumNous/new-api/common"
	"github.com/QuantumNous/new-api/model"
	relaycommon "github.com/QuantumNous/new-api/relay/common"
	"github.com/QuantumNous/new-api/relaykit/dto"
	"github.com/QuantumNous/new-api/relaykit/types"

	"github.com/gin-gonic/gin"
)

// keyDailyBudget returns the per-key limits configured for one key index. The
// channel-wide budgets still apply on top of these; both are "per local day".
func keyDailyBudget(setting dto.ChannelSettings, keyIndex int) (tokenLimit, requestLimit int64) {
	index := strconv.Itoa(keyIndex)
	if setting.KeyDailyTokenLimits != nil {
		tokenLimit = setting.KeyDailyTokenLimits[index]
	}
	if setting.KeyDailyRequestLimits != nil {
		requestLimit = setting.KeyDailyRequestLimits[index]
	}
	return tokenLimit, requestLimit
}

// NextKeyWithinDailyBudget picks the next enabled key that can serve right now:
// inside its own daily budgets, not resting after an upstream 429, and inside its
// per-minute request cap. Single-key channels behave exactly as before.
//
// A key that just served this client is preferred (key affinity) while it stays
// available, so a conversation does not hop accounts between requests.
//
// When every enabled key is blocked the request fails with 429: a full pool is a
// "temporarily unavailable" condition, and the code says which limit did it
// (daily budget vs per-key pacing).
func NextKeyWithinDailyBudget(c *gin.Context, channel *model.Channel) (string, int, *types.NewAPIError) {
	if channel == nil || !channel.ChannelInfo.IsMultiKey {
		return channel.GetNextEnabledKey()
	}
	// A key disabled while the rest of the channel kept serving never reaches the
	// background task's notice, so give it its cooldown check on the way in.
	model.RecoverCooledDownKeys(channel.Id)
	keyCount := len(channel.GetKeys())
	if keyCount == 0 {
		return channel.GetNextEnabledKey()
	}
	// Parse the setting once: each helper used to unmarshal the same JSON again,
	// which multiplied the work by the number of candidate keys per request.
	setting := channel.GetSetting()

	if preferred, ok := keyAffinityPreference(c, channel); ok {
		if admitted, _ := keyAdmits(channel, setting, preferred); admitted {
			return channel.GetKeys()[preferred], preferred, nil
		}
	}

	// Random mode can return the same key twice, so try twice per key before
	// concluding the pool is exhausted.
	sawBudgetLimit := false
	sawRateLimited := false
	sawExternalBlock := false
	var minCooldown int64
	rpmLimited := false
	externalPermanent := false
	var minExternalUntil int64
	for range keyCount * 2 {
		key, index, apiErr := channel.GetNextEnabledKey()
		if apiErr != nil {
			return "", 0, apiErr
		}
		admitted, rejection := keyAdmits(channel, setting, index)
		if admitted {
			return key, index, nil
		}
		switch rejection {
		case keyRejectedBudget:
			sawBudgetLimit = true
		case keyRejectedPacing:
			sawRateLimited = true
			if remaining := common.KeyCooldownRemainingSeconds(channel.Id, index); remaining > 0 {
				if minCooldown == 0 || remaining < minCooldown {
					minCooldown = remaining
				}
			} else {
				rpmLimited = true
			}
		case keyRejectedExternal:
			sawExternalBlock = true
			state := setting.KeyExternalStates[strconv.Itoa(index)]
			if state.Until <= 0 {
				externalPermanent = true
			} else if minExternalUntil == 0 || state.Until < minExternalUntil {
				minExternalUntil = state.Until
			}
		}
	}
	if sawBudgetLimit {
		return "", 0, types.NewError(
			errors.New("every enabled key reached its daily budget"),
			types.ErrorCodeChannelKeyDailyLimitExceeded,
			types.ErrOptionWithStatusCode(http.StatusTooManyRequests),
		)
	}
	if sawRateLimited {
		rateLimitedErr := types.NewError(
			errors.New("every enabled key is rate limited (per-key RPM or upstream cooldown)"),
			types.ErrorCodeChannelKeyRateLimited,
			types.ErrOptionWithStatusCode(http.StatusTooManyRequests),
		)
		retryAfter := minCooldown
		if retryAfter <= 0 && rpmLimited {
			// RPM uses a one-minute window; the next boundary frees the slot.
			retryAfter = int64(60 - time.Now().Second())
			if retryAfter <= 0 {
				retryAfter = 1
			}
		}
		rateLimitedErr.SetRetryAfterSeconds(retryAfter)
		return "", 0, rateLimitedErr
	}
	if sawExternalBlock {
		unavailableErr := types.NewError(
			errors.New("every enabled key is blocked by an external account state"),
			types.ErrorCodeChannelKeyUnavailable,
			types.ErrOptionWithStatusCode(http.StatusServiceUnavailable),
		)
		if !externalPermanent && minExternalUntil > time.Now().Unix() {
			unavailableErr.SetRetryAfterSeconds(minExternalUntil - time.Now().Unix())
		}
		return "", 0, unavailableErr
	}
	return "", 0, types.NewError(
		errors.New("every enabled key reached its daily budget"),
		types.ErrorCodeChannelKeyDailyLimitExceeded,
		types.ErrOptionWithStatusCode(http.StatusTooManyRequests),
	)
}

// IncreaseKeyDailyUsage records billable usage against the key that actually
// served the request. Only multi-key channels have a stable key index; callers
// on single-key channels get a no-op.
func IncreaseKeyDailyUsage(relayInfo *relaycommon.RelayInfo, tokens int64, countRequest bool) {
	if relayInfo == nil || !relayInfo.ChannelIsMultiKey {
		return
	}
	if tokens > 0 {
		if err := common.IncreaseKeyDailyTokenUsage(relayInfo.ChannelId, relayInfo.ChannelMultiKeyIndex, tokens); err != nil {
			common.SysError("per-key daily token usage not recorded: " + err.Error())
		}
	}
	if countRequest {
		if err := common.IncreaseKeyDailyRequestUsage(relayInfo.ChannelId, relayInfo.ChannelMultiKeyIndex); err != nil {
			common.SysError("per-key daily request usage not recorded: " + err.Error())
		}
	}
}

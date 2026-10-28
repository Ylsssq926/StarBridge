package service

import (
	"errors"
	"net/http"
	"strconv"

	"github.com/QuantumNous/new-api/common"
	"github.com/QuantumNous/new-api/model"
	relaycommon "github.com/QuantumNous/new-api/relay/common"
	"github.com/QuantumNous/new-api/relaykit/types"
)

// keyDailyBudget returns the per-key limits configured for one key index. The
// channel-wide budgets still apply on top of these; both are "per local day".
func keyDailyBudget(channel *model.Channel, keyIndex int) (tokenLimit, requestLimit int64) {
	if channel == nil {
		return 0, 0
	}
	setting := channel.GetSetting()
	index := strconv.Itoa(keyIndex)
	if setting.KeyDailyTokenLimits != nil {
		tokenLimit = setting.KeyDailyTokenLimits[index]
	}
	if setting.KeyDailyRequestLimits != nil {
		requestLimit = setting.KeyDailyRequestLimits[index]
	}
	return tokenLimit, requestLimit
}

// NextKeyWithinDailyBudget picks the next enabled key that still has room in its
// own daily budgets. Single-key channels behave exactly as before.
//
// When every enabled key is over budget the request fails with 429: a full
// key pool is a "temporarily full" condition, not a misconfiguration, and the
// code says so (channel:key_daily_limit_exceeded).
func NextKeyWithinDailyBudget(channel *model.Channel) (string, int, *types.NewAPIError) {
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
	// Random mode can return the same key twice, so try twice per key before
	// concluding the pool is exhausted.
	for range keyCount * 2 {
		key, index, apiErr := channel.GetNextEnabledKey()
		if apiErr != nil {
			return "", 0, apiErr
		}
		tokenLimit, requestLimit := keyDailyBudget(channel, index)
		if common.IsKeyDailyBudgetAvailable(channel.Id, index, tokenLimit, requestLimit) {
			return key, index, nil
		}
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

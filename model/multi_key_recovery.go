package model

import (
	"strconv"

	"github.com/QuantumNous/new-api/common"
)

// MultiKeyAutoRecoverOptionKey configures how long an automatically disabled key
// stays out of the pool. Default 30 minutes; <= 0 keeps automatic recovery off
// (the key then waits for a human, which is the pre-existing behaviour).
const MultiKeyAutoRecoverOptionKey = "MultiKeyAutoRecoverMinutes"

func multiKeyAutoRecoverMinutes() int {
	raw := ""
	if common.OptionMap != nil {
		raw = common.OptionMap[MultiKeyAutoRecoverOptionKey]
	}
	if raw == "" {
		return 30
	}
	minutes, err := strconv.Atoi(raw)
	if err != nil {
		common.SysError("invalid " + MultiKeyAutoRecoverOptionKey + " option, falling back to 30 minutes: " + err.Error())
		return 30
	}
	return minutes
}

// ListAutoDisabledChannelIDs returns the channels that are currently stopped by
// automatic disabling (all keys gone, or a single-key channel failed). The
// recovery task only needs the ids.
func ListAutoDisabledChannelIDs() ([]int, error) {
	var ids []int
	err := DB.Model(&Channel{}).
		Where("status = ?", common.ChannelStatusAutoDisabled).
		Pluck("id", &ids).Error
	return ids, err
}

// RecoverCooledDownKeys re-enables keys whose automatic disable has outlived the
// cooldown. The decision is made on the cached channel (that is what selection
// reads), then persisted through UpdateChannelStatus so status, abilities and the
// cache stay consistent — no second write path.
//
// Returns how many keys were brought back.
func RecoverCooledDownKeys(channelId int) int {
	cooldownMinutes := multiKeyAutoRecoverMinutes()
	if cooldownMinutes <= 0 {
		return 0
	}
	channel, err := CacheGetChannel(channelId)
	if err != nil || channel == nil || !channel.ChannelInfo.IsMultiKey {
		return 0
	}

	// Snapshot candidates under the polling lock (the same lock every other
	// writer of these maps holds), then re-enable outside it: UpdateChannelStatus
	// takes that lock itself.
	lock := GetChannelPollingLock(channelId)
	lock.Lock()
	candidates := make(map[int]string, 0)
	now := common.GetTimestamp()
	cooldownSeconds := int64(cooldownMinutes) * 60
	for index, status := range channel.ChannelInfo.MultiKeyStatusList {
		if keyCooldownElapsed(status, channel.ChannelInfo.MultiKeyDisabledTime[index], now, cooldownSeconds) {
			candidates[index] = ""
		}
	}
	lock.Unlock()
	if len(candidates) == 0 {
		return 0
	}

	keys := channel.GetKeys()
	recovered := 0
	for index := range candidates {
		if index < 0 || index >= len(keys) {
			continue
		}
		if UpdateChannelStatus(channelId, keys[index], common.ChannelStatusEnabled, "auto recovery: cooldown elapsed") {
			recovered++
		}
	}
	if recovered > 0 {
		common.SysLog(common.LogText("multi-key channel #%d: %d key(s) recovered after cooldown", channelId, recovered))
	}
	return recovered
}

// keyCooldownElapsed decides whether an auto-disabled key may come back. Manual
// disables (status 2) never recover on their own, and a key without a recorded
// disable time is left alone rather than guessed at.
func keyCooldownElapsed(status int, disabledAt, now, cooldownSeconds int64) bool {
	if status != common.ChannelStatusAutoDisabled || disabledAt <= 0 || cooldownSeconds <= 0 {
		return false
	}
	return now-disabledAt >= cooldownSeconds
}

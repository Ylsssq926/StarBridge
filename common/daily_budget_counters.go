package common

import (
	"maps"
	"strconv"
	"strings"
	"sync"

	"github.com/QuantumNous/new-api/constant"
)

// Per-user and per-group daily budgets reuse the same counter machinery as the
// channel budgets (Redis with an in-process fallback, keys rolling at local
// midnight). The subject of a counter is a string so both numeric user ids and
// group names fit the same key format.
var (
	userDailyTokenMetric = dailyMetric{
		name:          "user_tokens",
		keyFmt:        constant.UserDailyTokenUsageKeyFmt,
		redisDisabled: "Redis is disabled; user daily token usage falls back to in-process memory and is not consistent across multiple instances",
		failureHint:   "user daily limit may not take effect across instances",
	}
	userDailyRequestMetric = dailyMetric{
		name:          "user_requests",
		keyFmt:        constant.UserDailyRequestUsageKeyFmt,
		redisDisabled: "Redis is disabled; user daily request usage falls back to in-process memory and is not consistent across multiple instances",
		failureHint:   "user daily limit may not take effect across instances",
	}
	groupDailyTokenMetric = dailyMetric{
		name:          "group_tokens",
		keyFmt:        constant.GroupDailyTokenUsageKeyFmt,
		redisDisabled: "Redis is disabled; group daily token usage falls back to in-process memory and is not consistent across multiple instances",
		failureHint:   "group daily limit may not take effect across instances",
	}
	groupDailyRequestMetric = dailyMetric{
		name:          "group_requests",
		keyFmt:        constant.GroupDailyRequestUsageKeyFmt,
		redisDisabled: "Redis is disabled; group daily request usage falls back to in-process memory and is not consistent across multiple instances",
		failureHint:   "group daily limit may not take effect across instances",
	}
)

func userDailySubject(userID int) string {
	if userID <= 0 {
		return ""
	}
	return strconv.Itoa(userID)
}

// GetUserDailyTokenUsage returns today's billable token usage for a user.
func GetUserDailyTokenUsage(userID int) int64 {
	return getDailyUsage(userDailyTokenMetric, userDailySubject(userID))
}

// GetUserDailyRequestUsage returns today's billable request count for a user.
func GetUserDailyRequestUsage(userID int) int64 {
	return getDailyUsage(userDailyRequestMetric, userDailySubject(userID))
}

// IsUserDailyBudgetAvailable reports whether the user may still spend under the
// given budgets. A non-positive limit means unlimited.
func IsUserDailyBudgetAvailable(userID int, tokenLimit, requestLimit int64) (ok bool, violatedMetric string) {
	subject := userDailySubject(userID)
	if !isDailyUsageAvailable(userDailyTokenMetric, subject, tokenLimit) {
		return false, "token"
	}
	if !isDailyUsageAvailable(userDailyRequestMetric, subject, requestLimit) {
		return false, "request"
	}
	return true, ""
}

// IncreaseUserDailyTokenUsage records billable tokens for the current day.
func IncreaseUserDailyTokenUsage(userID int, tokens int64) error {
	return increaseDailyUsage(userDailyTokenMetric, userDailySubject(userID), tokens)
}

// IncreaseUserDailyRequestUsage records one billable request for the current day.
func IncreaseUserDailyRequestUsage(userID int) error {
	return increaseDailyUsage(userDailyRequestMetric, userDailySubject(userID), 1)
}

// GetGroupDailyTokenUsage returns today's billable token usage for a group.
func GetGroupDailyTokenUsage(group string) int64 {
	return getDailyUsage(groupDailyTokenMetric, strings.TrimSpace(group))
}

// GetGroupDailyRequestUsage returns today's billable request count for a group.
func GetGroupDailyRequestUsage(group string) int64 {
	return getDailyUsage(groupDailyRequestMetric, strings.TrimSpace(group))
}

// IsGroupDailyBudgetAvailable reports whether the group may still spend under
// the given budgets. A non-positive limit means unlimited.
func IsGroupDailyBudgetAvailable(group string, tokenLimit, requestLimit int64) (ok bool, violatedMetric string) {
	subject := strings.TrimSpace(group)
	if !isDailyUsageAvailable(groupDailyTokenMetric, subject, tokenLimit) {
		return false, "token"
	}
	if !isDailyUsageAvailable(groupDailyRequestMetric, subject, requestLimit) {
		return false, "request"
	}
	return true, ""
}

// IncreaseGroupDailyTokenUsage records billable tokens for the current day.
func IncreaseGroupDailyTokenUsage(group string, tokens int64) error {
	return increaseDailyUsage(groupDailyTokenMetric, strings.TrimSpace(group), tokens)
}

// IncreaseGroupDailyRequestUsage records one billable request for the current day.
func IncreaseGroupDailyRequestUsage(group string) error {
	return increaseDailyUsage(groupDailyRequestMetric, strings.TrimSpace(group), 1)
}

// DailyBudget is one scope's per-day allowance. Zero means unlimited.
type DailyBudget struct {
	Token   int64 `json:"token"`
	Request int64 `json:"request"`
}

// GroupDailyBudgetOptionKey holds a JSON map of group name -> DailyBudget. Group
// budgets live in the options table (no schema change); the parsed map is cached
// by the raw option string so a runtime update is picked up without a restart.
const GroupDailyBudgetOptionKey = "GroupDailyBudget"

var groupDailyBudgetCache struct {
	sync.RWMutex
	raw     string
	byGroup map[string]DailyBudget
}

// GetGroupDailyBudget returns the budget configured for a group, or the zero
// budget (unlimited) when the option is unset or malformed.
func GetGroupDailyBudget(group string) DailyBudget {
	group = strings.TrimSpace(group)
	if group == "" {
		return DailyBudget{}
	}
	raw := ""
	if OptionMap != nil {
		raw = OptionMap[GroupDailyBudgetOptionKey]
	}

	groupDailyBudgetCache.RLock()
	if groupDailyBudgetCache.raw == raw && groupDailyBudgetCache.byGroup != nil {
		budget := groupDailyBudgetCache.byGroup[group]
		groupDailyBudgetCache.RUnlock()
		return budget
	}
	groupDailyBudgetCache.RUnlock()

	parsed := map[string]DailyBudget{}
	if strings.TrimSpace(raw) != "" {
		if err := UnmarshalJsonStr(raw, &parsed); err != nil {
			SysError("failed to parse " + GroupDailyBudgetOptionKey + " option, treating every group as unlimited: " + err.Error())
			parsed = map[string]DailyBudget{}
		}
	}

	groupDailyBudgetCache.Lock()
	groupDailyBudgetCache.raw = raw
	groupDailyBudgetCache.byGroup = parsed
	groupDailyBudgetCache.Unlock()

	return parsed[group]
}

// GetAllGroupDailyBudgets returns a copy of the configured group budgets. Callers
// may mutate the copy; the cache keeps its own map.
func GetAllGroupDailyBudgets() map[string]DailyBudget {
	GetGroupDailyBudget("__warm__") // ensures the cache is parsed for the current raw option
	groupDailyBudgetCache.RLock()
	defer groupDailyBudgetCache.RUnlock()
	out := make(map[string]DailyBudget, len(groupDailyBudgetCache.byGroup))
	maps.Copy(out, groupDailyBudgetCache.byGroup)
	return out
}

var (
	keyDailyTokenMetric = dailyMetric{
		name:          "key_tokens",
		keyFmt:        constant.KeyDailyTokenUsageKeyFmt,
		redisDisabled: "Redis is disabled; per-key daily token usage falls back to in-process memory and is not consistent across multiple instances",
		failureHint:   "per-key daily limit may not take effect across instances",
	}
	keyDailyRequestMetric = dailyMetric{
		name:          "key_requests",
		keyFmt:        constant.KeyDailyRequestUsageKeyFmt,
		redisDisabled: "Redis is disabled; per-key daily request usage falls back to in-process memory and is not consistent across multiple instances",
		failureHint:   "per-key daily limit may not take effect across instances",
	}
	keyDailyRecoveryMetric = dailyMetric{
		name:          "key_recoveries",
		keyFmt:        constant.KeyDailyRecoveryUsageKeyFmt,
		redisDisabled: "Redis is disabled; per-key recovery counts fall back to in-process memory and are not consistent across multiple instances",
		failureHint:   "the per-key recovery cap may not take effect across instances",
	}
)

func keyDailySubject(channelID, keyIndex int) string {
	if channelID <= 0 || keyIndex < 0 {
		return ""
	}
	return strconv.Itoa(channelID) + ":" + strconv.Itoa(keyIndex)
}

// GetKeyDailyTokenUsage returns today's billable token usage for one key of a
// multi-key channel (index is the key's position in the channel key list).
func GetKeyDailyTokenUsage(channelID, keyIndex int) int64 {
	return getDailyUsage(keyDailyTokenMetric, keyDailySubject(channelID, keyIndex))
}

// GetKeyDailyRequestUsage returns today's billable request count for one key.
func GetKeyDailyRequestUsage(channelID, keyIndex int) int64 {
	return getDailyUsage(keyDailyRequestMetric, keyDailySubject(channelID, keyIndex))
}

// IsKeyDailyBudgetAvailable reports whether this key may still serve under the
// given budgets. A non-positive limit means unlimited.
func IsKeyDailyBudgetAvailable(channelID, keyIndex int, tokenLimit, requestLimit int64) bool {
	subject := keyDailySubject(channelID, keyIndex)
	return isDailyUsageAvailable(keyDailyTokenMetric, subject, tokenLimit) &&
		isDailyUsageAvailable(keyDailyRequestMetric, subject, requestLimit)
}

// IncreaseKeyDailyTokenUsage records billable tokens against one key.
func IncreaseKeyDailyTokenUsage(channelID, keyIndex int, tokens int64) error {
	return increaseDailyUsage(keyDailyTokenMetric, keyDailySubject(channelID, keyIndex), tokens)
}

// IncreaseKeyDailyRequestUsage records one billable request against one key.
func IncreaseKeyDailyRequestUsage(channelID, keyIndex int) error {
	return increaseDailyUsage(keyDailyRequestMetric, keyDailySubject(channelID, keyIndex), 1)
}

// GetKeyDailyRecoveryCount returns how many times automatic recovery has brought
// this key back today. It bounds a key that keeps failing: without a cap the
// cooldown/recover cycle would probe the upstream forever.
func GetKeyDailyRecoveryCount(channelID, keyIndex int) int64 {
	return getDailyUsage(keyDailyRecoveryMetric, keyDailySubject(channelID, keyIndex))
}

func IncreaseKeyDailyRecoveryCount(channelID, keyIndex int) error {
	return increaseDailyUsage(keyDailyRecoveryMetric, keyDailySubject(channelID, keyIndex), 1)
}

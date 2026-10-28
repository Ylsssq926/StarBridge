package service

import (
	"net/http"

	"github.com/QuantumNous/new-api/common"
	"github.com/QuantumNous/new-api/i18n"
	"github.com/QuantumNous/new-api/model"
	"github.com/QuantumNous/new-api/relaykit/types"
)

// DailyBudgetExceeded says which scope's per-day budget a live request ran into.
// Both scopes are "temporarily full" conditions and answer 429, like the channel
// budgets; callers pick the error code and message from Scope+Metric.
type DailyBudgetExceeded struct {
	Scope  string // "user" or "group"
	Metric string // "token" or "request"
}

// CheckDailyBudgets reports the first exhausted per-day budget for this request.
// Order is fixed (user before group, tokens before requests) so the same state
// always produces the same error.
func CheckDailyBudgets(userID int, group string) *DailyBudgetExceeded {
	if userID > 0 {
		if setting, err := model.GetUserSetting(userID, false); err == nil {
			if setting.DailyTokenLimit > 0 || setting.DailyRequestLimit > 0 {
				if ok, metric := common.IsUserDailyBudgetAvailable(userID, setting.DailyTokenLimit, setting.DailyRequestLimit); !ok {
					return &DailyBudgetExceeded{Scope: "user", Metric: metric}
				}
			}
		}
	}
	if group != "" {
		budget := common.GetGroupDailyBudget(group)
		if budget.Token > 0 || budget.Request > 0 {
			if ok, metric := common.IsGroupDailyBudgetAvailable(group, budget.Token, budget.Request); !ok {
				return &DailyBudgetExceeded{Scope: "group", Metric: metric}
			}
		}
	}
	return nil
}

// IncreaseUserGroupDailyUsage records billable usage for the user and the group
// they are spending as. Tokens are only recorded when the request reported any;
// countRequest counts one billable request (async tasks and per-call priced work
// report no tokens, so the request budget is what stops them).
func IncreaseUserGroupDailyUsage(userID int, group string, tokens int64, countRequest bool) {
	if tokens > 0 {
		if err := common.IncreaseUserDailyTokenUsage(userID, tokens); err != nil {
			common.SysError("user daily token usage not recorded: " + err.Error())
		}
		if err := common.IncreaseGroupDailyTokenUsage(group, tokens); err != nil {
			common.SysError("group daily token usage not recorded: " + err.Error())
		}
	}
	if countRequest {
		if err := common.IncreaseUserDailyRequestUsage(userID); err != nil {
			common.SysError("user daily request usage not recorded: " + err.Error())
		}
		if err := common.IncreaseGroupDailyRequestUsage(group); err != nil {
			common.SysError("group daily request usage not recorded: " + err.Error())
		}
	}
}

// StatusCode is always 429: both scopes describe a "temporarily full" budget,
// exactly like an exhausted channel budget.
func (e *DailyBudgetExceeded) StatusCode() int { return http.StatusTooManyRequests }

// Code is the client-facing error code for this scope and metric.
func (e *DailyBudgetExceeded) Code() types.ErrorCode {
	switch e.Scope {
	case "user":
		if e.Metric == "request" {
			return types.ErrorCodeUserDailyRequestLimitExceeded
		}
		return types.ErrorCodeUserDailyTokenLimitExceeded
	default:
		if e.Metric == "request" {
			return types.ErrorCodeGroupDailyRequestLimitExceeded
		}
		return types.ErrorCodeGroupDailyTokenLimitExceeded
	}
}

// MessageID is the translated message for this scope and metric.
func (e *DailyBudgetExceeded) MessageID() string {
	switch e.Scope {
	case "user":
		if e.Metric == "request" {
			return i18n.MsgDistributorUserDailyRequestLimitExceeded
		}
		return i18n.MsgDistributorUserDailyTokenLimitExceeded
	default:
		if e.Metric == "request" {
			return i18n.MsgDistributorGroupDailyRequestLimitExceeded
		}
		return i18n.MsgDistributorGroupDailyTokenLimitExceeded
	}
}

package controller

import (
	"errors"
	"slices"
	"strconv"
	"strings"

	"github.com/QuantumNous/new-api/common"
	"github.com/QuantumNous/new-api/model"

	"github.com/gin-gonic/gin"
)

// userDailyBudgetSnapshot renders one user's per-day budget state. Limits live in
// the user's JSON setting; usage comes from the same counters enforcement reads,
// so the two can never disagree.
func userDailyBudgetSnapshot(user *model.User) gin.H {
	setting := user.GetSetting()
	return gin.H{
		"user_id":             user.Id,
		"username":            user.Username,
		"group":               user.Group,
		"daily_token_limit":   setting.DailyTokenLimit,
		"tokens_used":         common.GetUserDailyTokenUsage(user.Id),
		"daily_request_limit": setting.DailyRequestLimit,
		"requests_used":       common.GetUserDailyRequestUsage(user.Id),
	}
}

// GetUserDailyBudget is read-only: GET /api/user/:id/daily_budget (admin).
func GetUserDailyBudget(c *gin.Context) {
	id, err := strconv.Atoi(c.Param("id"))
	if err != nil || id <= 0 {
		common.ApiError(c, errors.New("invalid user id"))
		return
	}
	// selectAll=false keeps the password hash and access token out of memory:
	// this endpoint only needs identity fields and the JSON setting.
	user, err := model.GetUserById(id, false)
	if err != nil {
		common.ApiError(c, err)
		return
	}
	common.ApiSuccess(c, userDailyBudgetSnapshot(user))
}

type userDailyBudgetRequest struct {
	DailyTokenLimit   int64 `json:"daily_token_limit"`
	DailyRequestLimit int64 `json:"daily_request_limit"`
}

// UpdateUserDailyBudget sets a user's per-day budgets: PUT /api/user/:id/daily_budget
// (admin). Zero means unlimited; negative values are rejected rather than guessed at.
func UpdateUserDailyBudget(c *gin.Context) {
	id, err := strconv.Atoi(c.Param("id"))
	if err != nil || id <= 0 {
		common.ApiError(c, errors.New("invalid user id"))
		return
	}
	var req userDailyBudgetRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		common.ApiError(c, err)
		return
	}
	if req.DailyTokenLimit < 0 || req.DailyRequestLimit < 0 {
		common.ApiError(c, errors.New("daily limits must be >= 0 (0 means unlimited)"))
		return
	}
	user, err := model.GetUserById(id, false)
	if err != nil {
		common.ApiError(c, err)
		return
	}
	// Merge into the existing JSON setting: notification channels, webhooks and
	// other per-user preferences live in the same column and must survive.
	setting := user.GetSetting()
	setting.DailyTokenLimit = req.DailyTokenLimit
	setting.DailyRequestLimit = req.DailyRequestLimit
	if err := model.UpdateUserSetting(id, setting); err != nil {
		common.ApiError(c, err)
		return
	}
	user.Setting = ""
	user.SetSetting(setting)
	common.ApiSuccess(c, userDailyBudgetSnapshot(user))
}

// GetGroupDailyBudgets lists every configured group budget with today's usage:
// GET /api/group/daily_budget (admin).
func GetGroupDailyBudgets(c *gin.Context) {
	budgets := common.GetAllGroupDailyBudgets()
	names := make([]string, 0, len(budgets))
	for group := range budgets {
		names = append(names, group)
	}
	slices.Sort(names)
	items := make([]gin.H, 0, len(names))
	for _, group := range names {
		budget := budgets[group]
		items = append(items, gin.H{
			"group":               group,
			"daily_token_limit":   budget.Token,
			"tokens_used":         common.GetGroupDailyTokenUsage(group),
			"daily_request_limit": budget.Request,
			"requests_used":       common.GetGroupDailyRequestUsage(group),
		})
	}
	common.ApiSuccess(c, items)
}

type groupDailyBudgetRequest struct {
	Group             string `json:"group"`
	DailyTokenLimit   int64  `json:"daily_token_limit"`
	DailyRequestLimit int64  `json:"daily_request_limit"`
}

// UpdateGroupDailyBudget writes one group's budget into the GroupDailyBudget
// option: PUT /api/group/daily_budget (admin). The option is a JSON map so the
// whole map is read, updated and written back; it takes effect without restart.
func UpdateGroupDailyBudget(c *gin.Context) {
	var req groupDailyBudgetRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		common.ApiError(c, err)
		return
	}
	group := strings.TrimSpace(req.Group)
	if group == "" {
		common.ApiError(c, errors.New("group is required"))
		return
	}
	if req.DailyTokenLimit < 0 || req.DailyRequestLimit < 0 {
		common.ApiError(c, errors.New("daily limits must be >= 0 (0 means unlimited)"))
		return
	}
	budgets := common.GetAllGroupDailyBudgets()
	budgets[group] = common.DailyBudget{Token: req.DailyTokenLimit, Request: req.DailyRequestLimit}
	payload, err := common.Marshal(budgets)
	if err != nil {
		common.ApiError(c, err)
		return
	}
	if err := model.UpdateOption(common.GroupDailyBudgetOptionKey, string(payload)); err != nil {
		common.ApiError(c, err)
		return
	}
	common.ApiSuccess(c, gin.H{
		"group":               group,
		"daily_token_limit":   req.DailyTokenLimit,
		"tokens_used":         common.GetGroupDailyTokenUsage(group),
		"daily_request_limit": req.DailyRequestLimit,
		"requests_used":       common.GetGroupDailyRequestUsage(group),
	})
}

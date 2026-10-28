package controller

import (
	"errors"
	"fmt"
	"strconv"
	"strings"

	"github.com/QuantumNous/new-api/common"
	"github.com/QuantumNous/new-api/model"
	"github.com/QuantumNous/new-api/relaykit/dto"

	"github.com/gin-gonic/gin"
)

type keyStateRequest struct {
	Index  int    `json:"index"`
	State  string `json:"state"`
	Reason string `json:"reason"`
	Until  int64  `json:"until"`
}

// UpdateChannelKeyState records an account state reported from outside the
// gateway (the sidecar that owns the accounts): PUT /api/channel/:id/key_state.
// A blocked state keeps the key out of selection until "until" (unix seconds)
// passes or the state is cleared with "normal". The gateway does not detect
// quota exhaustion, suspension or invalid credentials on its own.
func UpdateChannelKeyState(c *gin.Context) {
	id, err := strconv.Atoi(c.Param("id"))
	if err != nil || id <= 0 {
		common.ApiError(c, errors.New("invalid channel id"))
		return
	}
	channel, err := model.GetChannelById(id, true)
	if err != nil {
		common.ApiError(c, err)
		return
	}
	if channel == nil {
		common.ApiError(c, errors.New("channel not found"))
		return
	}
	if !channel.ChannelInfo.IsMultiKey {
		common.ApiError(c, errors.New("per-key account state only applies to multi-key channels"))
		return
	}
	var req keyStateRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		common.ApiError(c, err)
		return
	}
	keys := channel.GetKeys()
	if req.Index < 0 || req.Index >= len(keys) {
		common.ApiError(c, fmt.Errorf("key index %d is out of range (channel has %d keys)", req.Index, len(keys)))
		return
	}
	req.State = strings.TrimSpace(strings.ToLower(req.State))
	switch req.State {
	case "normal", "quota", "suspended", "invalid":
	default:
		common.ApiError(c, fmt.Errorf("unknown key state %q (expected normal, quota, suspended or invalid)", req.State))
		return
	}
	if req.Until < 0 {
		common.ApiError(c, errors.New("until must be a unix timestamp >= 0 (0 = until cleared)"))
		return
	}

	setting := channel.GetSetting()
	if setting.KeyExternalStates == nil {
		setting.KeyExternalStates = map[string]dto.KeyExternalState{}
	}
	indexKey := strconv.Itoa(req.Index)
	if req.State == "normal" {
		delete(setting.KeyExternalStates, indexKey)
	} else {
		setting.KeyExternalStates[indexKey] = dto.KeyExternalState{
			State:  req.State,
			Reason: strings.TrimSpace(req.Reason),
			Until:  req.Until,
		}
	}
	if err := model.UpdateChannelSettingOnly(id, setting); err != nil {
		common.ApiError(c, err)
		return
	}
	common.ApiSuccess(c, gin.H{
		"channel_id":          id,
		"index":               req.Index,
		"key_external_states": setting.KeyExternalStates,
	})
}

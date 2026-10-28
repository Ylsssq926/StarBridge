package controller

import (
	"errors"
	"fmt"
	"net/http"
	"strconv"
	"time"

	"github.com/QuantumNous/new-api/common"
	"github.com/QuantumNous/new-api/model"

	"github.com/gin-gonic/gin"
)

type testChannelKeyRequest struct {
	Index int    `json:"index"`
	Model string `json:"model"`
}

// TestChannelKey sends one minimal request through a specific key of a multi-key
// channel, so an operator can tell a broken credential from a broken channel
// without disabling the healthy keys first. It never bills and never changes key
// status; the response mirrors the channel test shape.
func TestChannelKey(c *gin.Context) {
	channelId, err := strconv.Atoi(c.Param("id"))
	if err != nil || channelId <= 0 {
		common.ApiError(c, errors.New("invalid channel id"))
		return
	}
	channel, err := model.GetChannelById(channelId, true)
	if err != nil {
		common.ApiError(c, err)
		return
	}
	if channel == nil {
		common.ApiError(c, errors.New("channel not found"))
		return
	}
	if !channel.ChannelInfo.IsMultiKey {
		common.ApiError(c, errors.New("per-key tests only apply to multi-key channels"))
		return
	}
	var req testChannelKeyRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		common.ApiError(c, err)
		return
	}
	keys := channel.GetKeys()
	if req.Index < 0 || req.Index >= len(keys) {
		common.ApiError(c, fmt.Errorf("key index %d is out of range (channel has %d keys)", req.Index, len(keys)))
		return
	}
	testUserID, err := resolveChannelTestUserID(c)
	if err != nil {
		common.ApiError(c, err)
		return
	}

	// The relay machinery selects a key for multi-key channels; hand it a
	// single-key copy pinned to the requested key instead.
	single := *channel
	single.ChannelInfo = channel.ChannelInfo
	single.ChannelInfo.IsMultiKey = false
	single.ChannelInfo.MultiKeyStatusList = nil
	single.ChannelInfo.MultiKeyDisabledReason = nil
	single.ChannelInfo.MultiKeyDisabledTime = nil
	single.Key = keys[req.Index]
	single.Keys = nil

	start := time.Now()
	result := testChannel(c.Request.Context(), &single, testUserID, req.Model, "", false)
	elapsed := time.Since(start).Seconds()
	keyTail := maskKeyTail(keys[req.Index])

	if result.localErr != nil {
		response := gin.H{
			"success":  false,
			"message":  result.localErr.Error(),
			"time":     0.0,
			"index":    req.Index,
			"key_tail": keyTail,
		}
		if result.newAPIError != nil {
			response["error_code"] = result.newAPIError.GetErrorCode()
		}
		c.JSON(http.StatusOK, response)
		return
	}
	if result.newAPIError != nil {
		c.JSON(http.StatusOK, gin.H{
			"success":    false,
			"message":    result.newAPIError.Error(),
			"time":       elapsed,
			"index":      req.Index,
			"key_tail":   keyTail,
			"error_code": result.newAPIError.GetErrorCode(),
		})
		return
	}
	c.JSON(http.StatusOK, gin.H{
		"success":  true,
		"message":  "",
		"time":     elapsed,
		"index":    req.Index,
		"key_tail": keyTail,
	})
}

package service

import (
	"errors"
	"net/http"
	"sync/atomic"
	"testing"

	"github.com/QuantumNous/new-api/common"
	"github.com/QuantumNous/new-api/model"
	relaycommon "github.com/QuantumNous/new-api/relay/common"
	"github.com/QuantumNous/new-api/relaykit/types"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func channelWithExternalStates(t *testing.T, raw string) *model.Channel {
	t.Helper()
	setting := raw
	channel := &model.Channel{Id: 1, Setting: &setting}
	require.NotPanics(t, func() { channel.GetSetting() })
	return channel
}

var keyFailureTestChannelID atomic.Int64

func TestKeyFailureAccountingIgnoresLocalErrors(t *testing.T) {
	previousRedis, previousOptions := common.RedisEnabled, common.OptionMap
	common.RedisEnabled = false
	common.OptionMap = map[string]string{KeyRateLimitCooldownOptionKey: "60"}
	t.Cleanup(func() {
		common.RedisEnabled = previousRedis
		common.OptionMap = previousOptions
	})

	channelID := 910027 + int(keyFailureTestChannelID.Add(1))
	const keyIndex = 0
	info := &relaycommon.RelayInfo{ChannelMeta: &relaycommon.ChannelMeta{ChannelId: channelID, ChannelIsMultiKey: true, ChannelMultiKeyIndex: keyIndex}}
	localError := types.NewErrorWithStatusCode(errors.New("client image is invalid"), types.ErrorCodeConvertRequestFailed, http.StatusTooManyRequests)
	MarkKeyRateLimited(info, localError)
	RecordKeyFailure(info, localError)
	assert.Zero(t, common.KeyCooldownRemainingSeconds(channelID, keyIndex))
	assert.Zero(t, common.GetKeyDailyFailureCount(channelID, keyIndex))

	upstreamRateLimit := types.NewOpenAIError(errors.New("rate limit exceeded"), types.ErrorCodeBadResponseStatusCode, http.StatusTooManyRequests)
	MarkKeyRateLimited(info, upstreamRateLimit)
	assert.Positive(t, common.KeyCooldownRemainingSeconds(channelID, keyIndex))

	upstreamFailure := types.WithOpenAIError(types.OpenAIError{Message: "Incorrect API key provided", Type: "invalid_request_error", Code: "invalid_api_key"}, http.StatusUnauthorized)
	RecordKeyFailure(info, upstreamFailure)
	assert.EqualValues(t, 1, common.GetKeyDailyFailureCount(channelID, keyIndex))
}

func TestExternalKeyStateBlocks(t *testing.T) {
	cases := []struct {
		name string
		raw  string
		want bool
	}{
		{"no state", `{}`, false},
		{"explicit normal", `{"key_external_states":{"0":{"state":"normal"}}}`, false},
		{"quota until future", `{"key_external_states":{"0":{"state":"quota","until":4102444800}}}`, true},
		{"quota expired", `{"key_external_states":{"0":{"state":"quota","until":1}}}`, false},
		{"suspended until cleared", `{"key_external_states":{"0":{"state":"suspended"}}}`, true},
		{"invalid credential", `{"key_external_states":{"0":{"state":"invalid"}}}`, true},
		{"unknown state is ignored", `{"key_external_states":{"0":{"state":"typo"}}}`, false},
		{"other key unaffected", `{"key_external_states":{"1":{"state":"quota"}}}`, false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			channel := channelWithExternalStates(t, tc.raw)
			setting := channel.GetSetting()
			assert.Equal(t, tc.want, externalKeyStateBlocks(setting, 0))
		})
	}
}

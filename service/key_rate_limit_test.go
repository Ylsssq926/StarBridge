package service

import (
	"testing"

	"github.com/QuantumNous/new-api/model"
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

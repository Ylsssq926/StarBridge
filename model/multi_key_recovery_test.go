package model

import (
	"testing"

	"github.com/QuantumNous/new-api/common"
	"github.com/stretchr/testify/assert"
)

func TestKeyCooldownElapsed(t *testing.T) {
	const cooldown = int64(30 * 60)

	cases := []struct {
		name      string
		status    int
		disabledA int64
		now       int64
		cooldown  int64
		want      bool
	}{
		{"auto-disabled long enough", common.ChannelStatusAutoDisabled, 1000, 1000 + cooldown, cooldown, true},
		{"auto-disabled but still cooling", common.ChannelStatusAutoDisabled, 1000, 1000 + cooldown - 1, cooldown, false},
		{"manual disable never auto-recovers", common.ChannelStatusManuallyDisabled, 1000, 1000 + cooldown*10, cooldown, false},
		{"enabled key is not a candidate", common.ChannelStatusEnabled, 1000, 1000 + cooldown, cooldown, false},
		{"missing disable time is left alone", common.ChannelStatusAutoDisabled, 0, 1000 + cooldown, cooldown, false},
		{"cooldown off disables recovery", common.ChannelStatusAutoDisabled, 1000, 1000 + cooldown, 0, false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got := keyCooldownElapsed(tc.status, tc.disabledA, tc.now, tc.cooldown)
			assert.Equal(t, tc.want, got)
		})
	}
	// Sanity: the "enabled key" row above documents that the predicate keys on
	// status, so an enabled key with an old timestamp must NOT be treated as
	// auto-disabled by callers; assert the negative explicitly as well.
	assert.False(t, keyCooldownElapsed(common.ChannelStatusEnabled, 1000, 1000+cooldown, cooldown))
}

func TestKeyRecoveryAllowed(t *testing.T) {
	const (
		cooldown = int64(30 * 60)
		disabled = int64(1000)
		now      = disabled + cooldown
	)
	cases := []struct {
		name      string
		status    int
		disabledA int64
		now       int64
		cooldown  int64
		today     int64
		limit     int64
		want      bool
	}{
		{"elapsed and under cap", common.ChannelStatusAutoDisabled, disabled, now, cooldown, 2, 5, true},
		{"elapsed but cap reached", common.ChannelStatusAutoDisabled, disabled, now, cooldown, 5, 5, false},
		{"cap zero means unlimited", common.ChannelStatusAutoDisabled, disabled, now, cooldown, 99, 0, true},
		{"manual disable never recovers", common.ChannelStatusManuallyDisabled, disabled, now, cooldown, 0, 5, false},
		{"still cooling", common.ChannelStatusAutoDisabled, disabled, now - 1, cooldown, 0, 5, false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			assert.Equal(t, tc.want, keyRecoveryAllowed(tc.status, tc.disabledA, tc.now, tc.cooldown, tc.today, tc.limit))
		})
	}
}

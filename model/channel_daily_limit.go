package model

import (
	"errors"

	"github.com/QuantumNous/new-api/common"
	"github.com/QuantumNous/new-api/dto"
)

// ErrChannelDailyTokenLimit means the model has candidate channels, but all of
// them reached their per-day token budget.
var ErrChannelDailyTokenLimit = errors.New("all candidate channels reached daily token limit")

// ErrChannelDailyRequestLimit means the model has candidate channels, but all of
// them reached their per-day request budget. Async image/video tasks and
// per-call priced requests report no usage, so the token budget alone would
// never stop them.
var ErrChannelDailyRequestLimit = errors.New("all candidate channels reached daily request limit")

// IsDailyLimitKind reports whether a violated filter is one of the per-day
// budgets. Those are the only filter violations that mean "temporarily full"
// rather than "misconfigured", so they surface as 429 instead of 503.
func IsDailyLimitKind(kind dto.ChannelFilterKind) bool {
	return kind == dto.FilterDailyTokenLimit || kind == dto.FilterDailyRequestLimit
}

// DailyLimitSentinel maps a violated per-day budget to its sentinel error, so
// callers do not have to branch on the filter kind at every selection site.
func DailyLimitSentinel(kind dto.ChannelFilterKind) error {
	if kind == dto.FilterDailyRequestLimit {
		return ErrChannelDailyRequestLimit
	}
	return ErrChannelDailyTokenLimit
}

// IsDailyLimitSentinel reports whether err is one of the per-day budget
// sentinels.
func IsDailyLimitSentinel(err error) bool {
	return errors.Is(err, ErrChannelDailyTokenLimit) || errors.Is(err, ErrChannelDailyRequestLimit)
}

// DailyLimitKindFromSentinel recovers the violated budget kind from a sentinel
// error, for call sites that only kept the error.
func DailyLimitKindFromSentinel(err error) dto.ChannelFilterKind {
	if errors.Is(err, ErrChannelDailyRequestLimit) {
		return dto.FilterDailyRequestLimit
	}
	return dto.FilterDailyTokenLimit
}

// channelWithinDailyTokenLimit reports whether the channel still has token budget today.
func channelWithinDailyTokenLimit(channel *Channel) bool {
	if channel == nil {
		return true
	}
	return common.IsChannelDailyTokenUsageAvailable(channel.Id, channel.GetSetting().DailyTokenLimit)
}

// channelWithinDailyRequestLimit reports whether the channel still has request budget today.
func channelWithinDailyRequestLimit(channel *Channel) bool {
	if channel == nil {
		return true
	}
	return common.IsChannelDailyRequestUsageAvailable(channel.Id, channel.GetSetting().DailyRequestLimit)
}

// channelDailyLimitViolation returns which per-day budget a channel exhausted,
// or "" while both budgets still have room.
func channelDailyLimitViolation(channel *Channel) dto.ChannelFilterKind {
	if channel == nil {
		return ""
	}
	if !channelWithinDailyTokenLimit(channel) {
		return dto.FilterDailyTokenLimit
	}
	if !channelWithinDailyRequestLimit(channel) {
		return dto.FilterDailyRequestLimit
	}
	return ""
}

// channelWithinDailyLimits reports whether the channel still has room in every
// per-day budget configured on it.
func channelWithinDailyLimits(channel *Channel) bool {
	return channelDailyLimitViolation(channel) == ""
}

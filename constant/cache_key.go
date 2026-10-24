package constant

// Cache keys
const (
	UserGroupKeyFmt                = "user_group:%d"
	UserQuotaKeyFmt                = "user_quota:%d"
	UserEnabledKeyFmt              = "user_enabled:%d"
	UserUsernameKeyFmt             = "user_name:%d"
	ChannelDailyTokenUsageKeyFmt   = "channel_daily_tokens:%d:%s"
	ChannelDailyRequestUsageKeyFmt = "channel_daily_requests:%d:%s"
	ChannelDailyRejectUsageKeyFmt  = "channel_daily_rejects:%d:%s"
)

const (
	TokenFiledRemainQuota = "RemainQuota"
	TokenFieldGroup       = "Group"
)

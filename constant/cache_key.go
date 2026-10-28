package constant

// Cache keys
const (
	UserGroupKeyFmt                = "user_group:%d"
	UserQuotaKeyFmt                = "user_quota:%d"
	UserEnabledKeyFmt              = "user_enabled:%d"
	UserUsernameKeyFmt             = "user_name:%d"
	ChannelDailyTokenUsageKeyFmt   = "channel_daily_tokens:%s:%s"
	ChannelDailyRequestUsageKeyFmt = "channel_daily_requests:%s:%s"
	ChannelDailyRejectUsageKeyFmt  = "channel_daily_rejects:%s:%s"
	UserDailyTokenUsageKeyFmt      = "user_daily_tokens:%s:%s"
	UserDailyRequestUsageKeyFmt    = "user_daily_requests:%s:%s"
	GroupDailyTokenUsageKeyFmt     = "group_daily_tokens:%s:%s"
	GroupDailyRequestUsageKeyFmt   = "group_daily_requests:%s:%s"
	KeyDailyTokenUsageKeyFmt       = "key_daily_tokens:%s:%s"
	KeyDailyRequestUsageKeyFmt     = "key_daily_requests:%s:%s"
)

const (
	TokenFiledRemainQuota = "RemainQuota"
	TokenFieldGroup       = "Group"
)

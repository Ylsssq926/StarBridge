package service

import (
	"time"

	"github.com/QuantumNous/new-api/common"
	"github.com/QuantumNous/new-api/model"
)

const multiKeyRecoveryInterval = time.Minute

// StartMultiKeyAutoRecoveryTask periodically gives auto-disabled keys another
// chance once their cooldown has passed. A channel whose keys were ALL disabled
// (and therefore the channel itself was auto-disabled) is no longer selected for
// requests, so it cannot recover lazily — this task is what brings it back.
func StartMultiKeyAutoRecoveryTask() {
	go func() {
		ticker := time.NewTicker(multiKeyRecoveryInterval)
		defer ticker.Stop()
		for range ticker.C {
			recoverAutoDisabledMultiKeyChannels()
		}
	}()
}

func recoverAutoDisabledMultiKeyChannels() {
	ids, err := model.ListAutoDisabledChannelIDs()
	if err != nil {
		common.SysError("failed to list auto-disabled channels for key recovery: " + err.Error())
		return
	}
	for _, id := range ids {
		model.RecoverCooledDownKeys(id)
	}
}

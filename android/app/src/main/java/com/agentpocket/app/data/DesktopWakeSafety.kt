package com.agentpocket.app.data

import com.agentpocket.app.data.model.DesktopRuntimeState
import com.agentpocket.app.data.model.HostRuntime

internal fun canRequestDesktopWake(online: Boolean, capable: Boolean, attestedChannel: String?, currentChannel: String?, runtime: HostRuntime?): Boolean =
    online && capable && currentChannel != null && currentChannel == attestedChannel &&
        runtime?.desktopState == DesktopRuntimeState.Closed && runtime.canWake && runtime.safeLaunch

internal fun sameWakeChannel(expected: Any?, current: Any?): Boolean = expected != null && expected === current

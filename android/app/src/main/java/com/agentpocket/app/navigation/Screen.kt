package com.agentpocket.app.navigation

/** Navigation graph. pairing -> inbox; inbox -> new task / detail / settings; detail -> diff. */
sealed interface Screen {
    data class Pairing(val keepSession: Boolean = false) : Screen

    data object Inbox : Screen

    data class NewTask(val agentId: String = "codex") : Screen

    data class Detail(val threadId: String) : Screen

    data class Diff(val threadId: String) : Screen

    data object Settings : Screen
}

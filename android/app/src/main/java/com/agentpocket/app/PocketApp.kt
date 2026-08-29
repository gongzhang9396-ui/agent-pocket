package com.agentpocket.app

import androidx.activity.compose.BackHandler
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.material3.Surface
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateListOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import com.agentpocket.app.data.PocketRepository
import com.agentpocket.app.navigation.Screen
import com.agentpocket.app.ui.screens.DiffScreen
import com.agentpocket.app.ui.screens.InboxScreen
import com.agentpocket.app.ui.screens.NewTaskScreen
import com.agentpocket.app.ui.screens.PairingScreen
import com.agentpocket.app.ui.screens.SessionDetailScreen
import com.agentpocket.app.ui.screens.SettingsScreen
import com.agentpocket.app.ui.theme.AgentPocketTheme

/**
 * App shell with a minimal back stack. 收件箱是默认路由，启动后直接进入主界面。
 * 需要显式注入 [PocketRepository]；生产环境由 MainActivity 的组合根提供。
 */
@Composable
fun PocketApp(repo: PocketRepository, initialThreadId: String? = null, launchRequestKey: Long = 0L) {
    AgentPocketTheme {
        val paired by repo.isPaired.collectAsState()
        val backStack = remember {
            mutableStateListOf<Screen>(
                if (!paired) Screen.Pairing else initialThreadId?.takeIf { it.isNotBlank() }?.let(Screen::Detail) ?: Screen.Inbox,
            )
        }
        var handledLaunchKey by remember { mutableStateOf(-1L) }

        fun push(screen: Screen) = backStack.add(screen)
        fun pop() {
            if (backStack.size > 1) backStack.removeAt(backStack.lastIndex)
        }

        fun popToInbox() {
            backStack.clear()
            backStack.add(Screen.Inbox)
        }

        BackHandler(enabled = backStack.size > 1) { pop() }

        LaunchedEffect(initialThreadId, launchRequestKey, paired) {
            if (!paired || launchRequestKey == handledLaunchKey) return@LaunchedEffect
            val threadId = initialThreadId?.takeIf { it.isNotBlank() } ?: return@LaunchedEffect
            handledLaunchKey = launchRequestKey
            val current = backStack.lastOrNull()
            if (current is Screen.Detail && current.threadId == threadId) return@LaunchedEffect
            if (current is Screen.Diff && current.threadId == threadId) return@LaunchedEffect
            push(Screen.Detail(threadId))
        }

        Surface(modifier = Modifier.fillMaxSize()) {
            when (val screen = backStack.last()) {
                Screen.Pairing -> PairingScreen(
                    repo = repo,
                    onPaired = { popToInbox() },
                    onBack = { pop() },
                )

                Screen.Inbox -> InboxScreen(
                    repo = repo,
                    onOpenThread = { push(Screen.Detail(it)) },
                    onNewTask = { push(Screen.NewTask) },
                    onOpenSettings = { push(Screen.Settings) },
                )

                Screen.NewTask -> NewTaskScreen(
                    repo = repo,
                    onBack = { pop() },
                    onCreated = { threadId ->
                        pop()
                        push(Screen.Detail(threadId))
                    },
                )

                is Screen.Detail -> SessionDetailScreen(
                    repo = repo,
                    threadId = screen.threadId,
                    onBack = { pop() },
                    onOpenDiff = { push(Screen.Diff(it)) },
                )

                is Screen.Diff -> DiffScreen(
                    repo = repo,
                    threadId = screen.threadId,
                    onBack = { pop() },
                )

                Screen.Settings -> SettingsScreen(
                    repo = repo,
                    onBack = { pop() },
                    onReenterPairing = { push(Screen.Pairing) },
                )
            }
        }
    }
}

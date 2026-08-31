package com.agentpocket.app.data.model

/** Connection state of the desktop Bridge reachable over a secure WSS relay. */
enum class ConnectionState { Connected, Connecting, Disconnected }

data class Host(
    val id: String,
    val name: String,
    val wssUrl: String,
    val connectionState: ConnectionState,
    val lastSeen: String,
    val relayName: String,
    val signingPublicKey: String = "",
    val encryptionPublicKey: String = "",
)

data class Device(
    val id: String,
    val name: String,
    val pairedAt: String,
    val notificationEnabled: Boolean,
    val status: String = "approved",
    val encryptionPublicKey: String = "",
)

data class ThreadRef(val hostId: String, val threadId: String) {
    fun encoded(): String = "$hostId\u001f$threadId"

    companion object {
        fun parse(value: String): ThreadRef {
            val index = value.indexOf('\u001f')
            require(index > 0 && index < value.lastIndex) { "任务引用缺少 Host 上下文" }
            return ThreadRef(value.substring(0, index), value.substring(index + 1))
        }
    }
}

data class Project(
    val id: String,
    val name: String,
    val cwd: String,
)

data class ReasoningOption(
    val id: String,
    val label: String,
    val description: String,
)

/**
 * A selectable Codex model. [reasoningOptions] varies per model, so the
 * reasoning selector in the new-task screen is shaped dynamically from here.
 */
data class ModelOption(
    val id: String,
    val label: String,
    val description: String,
    val reasoningOptions: List<ReasoningOption>,
)

enum class ThreadStatus { Active, NeedsAttention, Completed, Idle, DesktopOwned, ExternalBusy }

data class ThreadSummary(
    val id: String,
    val title: String,
    val cwd: String,
    val status: ThreadStatus,
    val updatedAt: String,
    val lastMessage: String,
    val unreadCount: Int,
    val hostId: String = "",
    val hostName: String = "",
)

enum class Role { User, Assistant, System }

enum class MessageStatus { Streaming, Done, Interrupted, Failed }

enum class StepStatus { Pending, InProgress, Done }

data class PlanStep(
    val index: Int,
    val text: String,
    val status: StepStatus,
)

enum class PlanStatus { InProgress, Done, Abandoned }

enum class CommandStatus { Running, Succeeded, Failed }

/** The only decisions the approval UI may ever offer. No permanent approval exists. */
enum class ApprovalDecision { AllowOnce, Deny, Cancel }

/**
 * Timeline entries of a thread. Rendered through a keyed LazyColumn so a later
 * 50 ms delta-coalescing layer can update items in place without redesign.
 */
sealed interface TimelineItem {
    val id: String

    data class Message(
        override val id: String,
        val role: Role,
        val text: String,
        val status: MessageStatus,
    ) : TimelineItem

    data class Plan(
        override val id: String,
        val steps: List<PlanStep>,
        val status: PlanStatus,
    ) : TimelineItem

    data class Command(
        override val id: String,
        val label: String,
        val cwd: String,
        val status: CommandStatus,
        val output: String,
        val truncated: Boolean,
    ) : TimelineItem

    data class Question(
        override val id: String,
        val requestId: String,
        val questionId: String,
        val prompt: String,
        val options: List<String>,
        val selectedOption: String? = null,
    ) : TimelineItem

    data class Approval(
        override val id: String,
        val requestId: String,
        val summary: String,
        val command: String,
        val cwd: String,
        val decision: ApprovalDecision? = null,
    ) : TimelineItem
}

data class ThreadDetail(
    val id: String,
    val title: String,
    val cwd: String,
    val status: ThreadStatus,
    val items: List<TimelineItem>,
    val activeTurnId: String?,
)

enum class DiffFileStatus { Added, Modified, Deleted, Renamed }

enum class DiffLineKind { Context, Add, Delete }

data class DiffLine(
    val kind: DiffLineKind,
    val text: String,
)

data class DiffHunk(
    val header: String,
    val lines: List<DiffLine>,
)

data class DiffFile(
    val path: String,
    val status: DiffFileStatus,
    val additions: Int,
    val deletions: Int,
    val hunks: List<DiffHunk>,
    val truncated: Boolean,
)

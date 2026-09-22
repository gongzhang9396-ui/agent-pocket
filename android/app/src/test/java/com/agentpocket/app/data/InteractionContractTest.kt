package com.agentpocket.app.data

import com.agentpocket.app.data.model.TimelineItem
import com.agentpocket.app.data.model.ApprovalDecision
import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Test

class InteractionContractTest {
    @Test fun firstLoadIsCurrentUntilAnActualThreadEventChangesTheVersion() {
        val versions = mutableMapOf<String, Long>()
        val captured = versions["thread"] ?: 0L
        assertTrue(sameThreadVersion(captured, versions["thread"]))
        versions["thread"] = 1L
        assertFalse(sameThreadVersion(captured, versions["thread"]))
        assertTrue(sameThreadVersion(1L, versions["thread"]))
        assertFalse(sameThreadVersion(1L, null))
    }

    @Test fun replayCannotErasePendingOrConfirmedSelections() {
        val request = TimelineItem.Question("r:q", "r", "q", "Choose", listOf("A", "B"))
        val draft = request.copy(pendingOption = "B", submitting = true)
        assertEquals(draft, mergeInteractionEvent(draft, request))
        val confirmed = request.copy(selectedOption = "A")
        assertEquals(confirmed, mergeInteractionEvent(confirmed, request))
        val approval = TimelineItem.Approval("a", "a", "Allow?", "echo test", "/tmp")
        assertEquals(ApprovalDecision.Deny, (mergeInteractionEvent(approval.copy(decision = ApprovalDecision.Deny), approval) as TimelineItem.Approval).decision)
        assertEquals("B", (mergeInteractionSnapshot(draft, request) as TimelineItem.Question).pendingOption)
        assertEquals("A", (mergeInteractionSnapshot(confirmed, request) as TimelineItem.Question).selectedOption)
        val fromDesktop = mergeInteractionSnapshot(draft, request.copy(selectedOption = "A")) as TimelineItem.Question
        assertEquals("A", fromDesktop.selectedOption)
        assertNull(fromDesktop.pendingOption)
        assertFalse(fromDesktop.submitting)
    }
    private fun parse(value: String) = interactionFromJson(Json.parseToJsonElement(value) as JsonObject)
    @Test fun restoresQuestionChoicesAndConfirmedFreeTextWithoutSelectingByDefault() {
        val q = parse("""{"type":"pocketQuestion","id":"r:q","requestId":"r","questionId":"q","prompt":"请选择","options":["A",{"label":"B"}]}""") as TimelineItem.Question
        assertEquals(listOf("A", "B"), q.options)
        assertNull(q.selectedOption)
        assertTrue(q.available)
        val answered = parse("""{"type":"pocketQuestion","id":"r:q","requestId":"r","questionId":"q","selectedOption":"自己的回答","available":false}""") as TimelineItem.Question
        assertEquals("自己的回答", answered.selectedOption)
        assertFalse(answered.available)
    }
    @Test fun expiredApprovalsStayVisibleButCannotBeApprovedAgain() {
        val a = parse("""{"type":"pocketApproval","id":"r","requestId":"r","available":false,"unavailableReason":"已结束"}""") as TimelineItem.Approval
        assertFalse(a.available)
        assertEquals("已结束", a.unavailableReason)
        assertNull(a.decision)
        assertEquals(ApprovalDecision.Deny, (parse("""{"type":"pocketApproval","id":"r","requestId":"r","decision":"deny"}""") as TimelineItem.Approval).decision)
        assertNull(parse("""{"type":"pocketApproval","id":"r"}"""))
    }

    private fun event(type: String, turn: String = "t", payload: String, thread: String = "grok:session") =
        Json.parseToJsonElement("""{"eventId":"event","threadId":"$thread","turnId":"$turn","type":"$type","payload":$payload}""") as JsonObject

    private fun request(id: String, turn: String = "t", thread: String = "grok:session") = event("approval.request", turn,
        """{"id":"grok-approval-$id","type":"pocketApproval","requestId":"$id","summary":"Allow $id?","command":"fixture","cwd":"/tmp"}""", thread)

    @Test fun legacyRecoveryClosesResolvedTurnsAndKeepsOnlyCurrentRequestsActionable() {
        val events = listOf(request("old"), event("sync.required", payload = """{"reason":"approval-resolved"}"""),
            request("next"), request("elsewhere", thread = "grok:other"),
            event("message.delta", payload = """{"delta":"must not replay"}"""))
        val recovered = recoverGrokApprovals("grok:session", events)
        assertEquals(listOf("old", "next"), recovered.map { it.requestId })
        assertFalse(recovered.first().available)
        assertNull(recovered.first().decision) // Old hosts do not tell us the decision.
        assertTrue(recovered.last().available)
        assertEquals("grok-approval-next", recovered.last().id)
        assertEquals(listOf("next"), mergeRecoveredGrokApprovals(emptyList(), recovered).map { (it as TimelineItem.Approval).requestId })
        val ended = recoverGrokApprovals("grok:session", events + event("turn.status", payload = """{"status":"completed"}"""))
        assertTrue(mergeRecoveredGrokApprovals(emptyList(), ended).isEmpty())
        assertTrue(recoverGrokApprovals("codex:session", events).isEmpty())
    }

    @Test fun scopedResolutionKeepsOtherParallelApprovalsAndLaterTurnsOpen() {
        val events = listOf(request("a"), request("b"), request("later", turn = "t2"),
            event("sync.required", payload = """{"reason":"approval-resolved","requestId":"a","decision":"deny"}"""))
        val recovered = recoverGrokApprovals("grok:session", events)
        assertEquals(ApprovalDecision.Deny, recovered.first().decision)
        assertFalse(recovered.first().available)
        assertTrue(recovered.drop(1).all { it.available })
        val ended = recoverGrokApprovals("grok:session", events + event("turn.status", payload = """{"status":"interrupted"}"""))
        assertEquals(listOf("later"), ended.filter { it.available }.map { it.requestId })
    }

    @Test fun recoveryPreservesMessagesAndLocalResponsesAndDeduplicatesNativeApprovalIds() {
        val recovered = recoverGrokApprovals("grok:session", listOf(request("a"), request("b")))
        val localA = recovered[0].copy(id = "old-event-id", decision = ApprovalDecision.AllowOnce)
        val localB = recovered[1].copy(submitting = true)
        val message = TimelineItem.Message("m", com.agentpocket.app.data.model.Role.Assistant, "one copy", com.agentpocket.app.data.model.MessageStatus.Streaming)
        val merged = mergeRecoveredGrokApprovals(listOf(message, localA, localB, recovered[0]), recovered)
        assertEquals(3, merged.size)
        assertEquals(message, merged[0])
        assertEquals(ApprovalDecision.AllowOnce, (merged[1] as TimelineItem.Approval).decision)
        assertEquals("grok-approval-a", merged[1].id)
        assertTrue((merged[2] as TimelineItem.Approval).submitting)
    }

    private fun stored(event: JsonObject, type: String, host: String = "host", account: String = "account") = buildJsonObject {
        put("seq", 123)
        put("envelope", RelayProtocolJson.encodeToJsonElement(RelayEnvelope(account, host, host, "events", 7,
            "event.append", event.toString(), "event", type)))
    }

    @Test fun encryptedRecoveryUsesCoarseRelayTypesAndAuthenticatesOnlyTheMatchingHostAccount() {
        val stored = JsonArray(listOf(stored(request("wrong-host"), "attention", host = "other"),
            stored(request("wrong-account"), "attention", account = "other"), stored(request("pending"), "attention")))
        var decrypted = 0
        val recovered = recoverEncryptedGrokApprovals("account", "host", "grok:session", stored) { decrypted++; it.ciphertext }
        assertEquals(1, decrypted)
        assertEquals(listOf("pending"), recovered.map { it.requestId })
        val ended = JsonArray(stored + stored(event("turn.status", payload = """{"status":"completed"}"""), "completed"))
        assertTrue(recoverEncryptedGrokApprovals("account", "host", "grok:session", ended) { it.ciphertext }.none { it.available })
    }

    @Test fun oneUnauthenticatedResolutionAbortsTheWholeRecovery() {
        val stored = JsonArray(listOf(stored(request("pending"), "attention"),
            stored(event("sync.required", payload = """{"reason":"approval-resolved"}"""), "status")))
        assertThrows(IllegalStateException::class.java) {
            recoverEncryptedGrokApprovals("account", "host", "grok:session", stored) {
                check(it.eventType != "status") { "fixture authentication failure" }; it.ciphertext
            }
        }
    }
}

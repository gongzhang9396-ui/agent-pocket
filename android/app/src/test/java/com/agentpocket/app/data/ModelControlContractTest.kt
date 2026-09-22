package com.agentpocket.app.data

import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Test

class ModelControlContractTest {
    private fun obj(value: String) = Json.parseToJsonElement(value) as JsonObject

    @Test fun inheritedSettingsNeverSendAnOverrideAndSteerRejectsASelectedModel() {
        assertTrue(turnModelOverride(null, null, false).isEmpty())
        assertTrue(turnModelOverride(null, null, true).isEmpty())
        assertEquals(obj("""{"model":"vendor-model","effort":"high"}"""), turnModelOverride("vendor-model", "high", false))
        assertThrows(IllegalArgumentException::class.java) { turnModelOverride("vendor-model", "high", true) }
        assertThrows(IllegalArgumentException::class.java) { turnModelOverride(null, "high", false) }
    }

    @Test fun catalogUsesWireModelIdsFiltersAgentsAndKeepsUnknownCurrentSettings() {
        val value = obj("""{"controlScope":"thread","currentModel":"retired-model","currentEffort":"medium","data":[
            {"id":"display-key","model":"api-model","displayName":"API","supportedReasoningEfforts":[{"reasoningEffort":"high"},{"reasoningEffort":"high"},{"reasoningEffort":""}],"defaultReasoningEffort":"high"},
            {"id":"grok","agentId":"grok"}]}""")
        val options = parseThreadModelOptions(value, "codex")
        assertTrue(options.canControl)
        assertEquals("retired-model", options.currentModelId)
        assertEquals(listOf("api-model"), options.models.map { it.id })
        assertEquals("high", options.models.single().defaultReasoningId)
        assertEquals(listOf("high"), options.models.single().reasoningOptions.map { it.id })
    }

    @Test fun missingOrUnknownCapabilitiesNeverEnableModelControl() {
        assertFalse(parseThreadModelOptions(obj("{}"), "codex").canControl)
        assertTrue(parseThreadModelOptions(obj("""{"controlScope":"desktop"}"""), "codex").canControl)
        assertFalse(parseThreadModelOptions(obj("""{"controlScope":"unknown"}"""), "codex").canControl)
        assertTrue(parseThreadModelOptions(obj("""{"controlScope":"shared"}"""), "grok").canControl)
        assertNull(modelOptionFromJson(obj("""{"id":"m","defaultReasoningEffort":"high"}"""))?.defaultReasoningId)
    }
}

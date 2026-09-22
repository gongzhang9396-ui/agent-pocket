package com.agentpocket.app.data

import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Test

class RpcErrorContractTest {
    @Test fun hostNamedErrorsTakePrecedenceOverNumericJsonRpcCodes() {
        for (name in listOf("HISTORY_CHANGED", "HISTORY_UNAVAILABLE", "INVALID_REQUEST", "HOST_OFFLINE", "EVENT_GAP")) {
            val error = bridgeRpcError(Json.parseToJsonElement("""{"code":-32603,"message":"fixture","data":{"name":"$name"}}""") as JsonObject, "fallback")
            assertEquals(name, error.nameCode)
            assertEquals("fixture", error.message)
        }
    }

    @Test fun relayStringCodesAndUnknownErrorsRemainReadable() {
        assertEquals("HOST_OFFLINE", bridgeRpcError(Json.parseToJsonElement("""{"code":"HOST_OFFLINE"}""") as JsonObject, "fallback").nameCode)
        val unknown = bridgeRpcError(JsonObject(emptyMap()), "fallback")
        assertNull(unknown.nameCode)
        assertEquals("fallback", unknown.message)
    }
}

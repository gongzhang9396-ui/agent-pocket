package com.agentpocket.app.data

import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.atomic.AtomicLong
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.TimeoutCancellationException
import kotlinx.coroutines.withTimeout
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.longOrNull
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.put
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener

internal class BridgeRpcException(message: String, val nameCode: String? = null) : Exception(message)

private const val RPC_TIMEOUT_MS = 30_000L

internal class BridgeRpcClient(
    private val http: OkHttpClient,
    private val endpoint: String,
    private val token: String?,
    private val onEvent: (JsonObject) -> Unit,
) : WebSocketListener() {
    private val json = Json { ignoreUnknownKeys = true }
    private val nextId = AtomicLong(1)
    private val pending = ConcurrentHashMap<Long, CompletableDeferred<JsonElement>>()
    private val opened = CompletableDeferred<Unit>()
    private val closed = CompletableDeferred<Unit>()
    private var socket: WebSocket? = null

    fun connect() {
        val request = Request.Builder().url(endpoint).apply {
            if (!token.isNullOrBlank()) header("Authorization", "Bearer $token")
        }.build()
        socket = http.newWebSocket(request, this)
    }

    suspend fun awaitOpen() = opened.await()
    suspend fun awaitClosed() = closed.await()

    suspend fun call(method: String, params: JsonObject = JsonObject(emptyMap())): JsonElement {
        var requestId: Long? = null
        var response: CompletableDeferred<JsonElement>? = null
        return try {
            withTimeout(RPC_TIMEOUT_MS) {
                awaitOpen()
                val id = nextId.getAndIncrement()
                val deferred = CompletableDeferred<JsonElement>()
                requestId = id
                response = deferred
                pending[id] = deferred
                val message = buildJsonObject {
                    put("jsonrpc", "2.0")
                    put("id", id)
                    put("method", method)
                    put("params", params)
                }
                if (socket?.send(message.toString()) != true) {
                    throw BridgeRpcException("Bridge 连接已关闭")
                }
                deferred.await()
            }
        } catch (_: TimeoutCancellationException) {
            throw BridgeRpcException("Bridge 请求超时，请检查 Windows 连接")
        } finally {
            val id = requestId
            val deferred = response
            if (id != null && deferred != null) pending.remove(id, deferred)
        }
    }

    fun close() {
        socket?.close(1000, "client closing")
        finish(BridgeRpcException("Bridge 连接已关闭"))
    }

    override fun onOpen(webSocket: WebSocket, response: Response) {
        opened.complete(Unit)
    }

    override fun onMessage(webSocket: WebSocket, text: String) {
        val message = runCatching { json.parseToJsonElement(text) as? JsonObject }.getOrNull() ?: return
        val method = (message["method"] as? JsonPrimitive)?.contentOrNull
        if (method == "bridge/event") {
            (message["params"] as? JsonObject)?.let { event -> runCatching { onEvent(event) } }
            return
        }
        val id = (message["id"] as? JsonPrimitive)?.longOrNull ?: return
        val deferred = pending.remove(id) ?: return
        val error = message["error"] as? JsonObject
        if (error != null) {
            val data = error["data"] as? JsonObject
            deferred.completeExceptionally(
                BridgeRpcException(
                    (error["message"] as? JsonPrimitive)?.contentOrNull ?: "Bridge 请求失败",
                    (data?.get("name") as? JsonPrimitive)?.contentOrNull,
                ),
            )
        } else {
            val result = message["result"]
            if (result == null) {
                deferred.completeExceptionally(BridgeRpcException("Bridge 返回缺少 result，协议格式不兼容"))
            } else {
                deferred.complete(result)
            }
        }
    }

    override fun onClosed(webSocket: WebSocket, code: Int, reason: String) = finish(null)

    override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) = finish(t)

    private fun finish(cause: Throwable?) {
        val error = cause ?: BridgeRpcException("Bridge 连接已关闭")
        if (!opened.isCompleted) opened.completeExceptionally(error)
        pending.values.forEach { it.completeExceptionally(error) }
        pending.clear()
        if (cause == null) closed.complete(Unit) else closed.completeExceptionally(cause)
    }
}

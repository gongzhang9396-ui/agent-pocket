package com.agentpocket.app.data

import java.io.IOException
import java.util.concurrent.TimeUnit
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.longOrNull
import kotlinx.serialization.json.put
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody

internal class RelayTokenRefresh(
    private val responseStatus: (Int) -> Unit = { android.util.Log.i("PocketSession", "Refresh response: http=$it"); Unit },
) {
    // Refresh is single-use: do not silently resend it after an ambiguous failure.
    private val http = OkHttpClient.Builder().retryOnConnectionFailure(false)
        .followRedirects(false).followSslRedirects(false).callTimeout(30, TimeUnit.SECONDS).build()
    private val json = Json { ignoreUnknownKeys = true }

    suspend fun refresh(credentials: RelayCredentials): RelayCredentials = withContext(Dispatchers.IO) {
        val request = Request.Builder().url("${credentials.endpoint.trimEnd('/')}/api/auth/refresh")
            .post(buildJsonObject { put("refreshToken", credentials.refreshToken) }.toString()
                .toRequestBody("application/json".toMediaType())).build()
        http.newCall(request).execute().use { response ->
            responseStatus(response.code)
            if (response.code == 401) throw AccessRejectedException()
            if (!response.isSuccessful) throw IOException("登录续期暂时失败 (${response.code})，请稍后重试")
            try {
                val result = json.parseToJsonElement(response.body?.string().orEmpty()) as? JsonObject
                    ?: throw IOException("登录续期返回格式无效")
                fun text(key: String) = (result[key] as? JsonPrimitive)?.contentOrNull
                    ?.takeIf { it.isNotBlank() } ?: throw IOException("登录续期返回不完整")
                fun number(key: String) = (result[key] as? JsonPrimitive)?.longOrNull
                    ?: throw IOException("登录续期返回不完整")
                credentials.copy(accessToken = text("accessToken"), refreshToken = text("refreshToken"),
                    accessExpiresAt = number("accessExpiresAt"), refreshExpiresAt = number("refreshExpiresAt"))
            } catch (error: Exception) { throw RefreshConsumedException(error) }
        }
    }
}

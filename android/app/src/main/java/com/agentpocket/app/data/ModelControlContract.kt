package com.agentpocket.app.data

import com.agentpocket.app.data.model.ModelOption
import com.agentpocket.app.data.model.ReasoningOption
import com.agentpocket.app.data.model.ThreadModelOptions
import kotlinx.serialization.json.*

private fun JsonObject.text(key: String) = (get(key) as? JsonPrimitive)?.contentOrNull?.takeIf { it.isNotBlank() }

internal fun reasoningLabel(value: String) = when (value) {
    "none" -> "无"; "minimal" -> "极低"; "low" -> "低"; "medium" -> "中"
    "high" -> "高"; "xhigh" -> "极高"; "max" -> "最大"; "ultra" -> "超高"; else -> value
}

internal fun modelOptionFromJson(element: JsonElement): ModelOption? {
    val model = element as? JsonObject ?: return null
    val id = model.text("model") ?: model.text("id") ?: return null
    val efforts = (model["supportedReasoningEfforts"] as? JsonArray).orEmpty().mapNotNull {
        val option = it as? JsonObject ?: return@mapNotNull null
        val effort = option.text("reasoningEffort") ?: return@mapNotNull null
        ReasoningOption(effort, reasoningLabel(effort), option.text("description").orEmpty())
    }.distinctBy { it.id }
    return ModelOption(id, model.text("displayName") ?: id, model.text("description").orEmpty(), efforts,
        model.text("agentId") ?: "codex", model.text("defaultReasoningEffort")?.takeIf { value -> efforts.any { it.id == value } })
}

internal fun parseThreadModelOptions(value: JsonObject, agentId: String): ThreadModelOptions = ThreadModelOptions(
    models = (value["data"] as? JsonArray).orEmpty().mapNotNull(::modelOptionFromJson).filter { it.agentId == agentId }.distinctBy { it.id },
    currentModelId = value.text("currentModel"),
    currentReasoningId = value.text("currentEffort"),
    controlScope = value.text("controlScope") ?: "none",
    reason = value.text("reason"),
    warning = value.text("warning"),
)

/** Inherit means omit parameters. Never silently downgrade a selected model to steer. */
internal fun turnModelOverride(modelId: String?, reasoningId: String?, running: Boolean): JsonObject {
    val model = modelId?.trim()?.takeIf { it.isNotEmpty() }
    val effort = reasoningId?.trim()?.takeIf { it.isNotEmpty() }
    require(!running || (model == null && effort == null)) { "本轮回复已开始，请等结束后再使用所选模型发送。" }
    require(effort == null || model != null) { "请先选择模型，再选择推理档位。" }
    return buildJsonObject { model?.let { put("model", it) }; effort?.let { put("effort", it) } }
}

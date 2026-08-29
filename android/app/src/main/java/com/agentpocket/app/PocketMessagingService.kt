package com.agentpocket.app

import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Intent
import androidx.core.app.NotificationCompat
import com.google.firebase.messaging.FirebaseMessagingService
import com.google.firebase.messaging.RemoteMessage

class PocketMessagingService : FirebaseMessagingService() {
    override fun onNewToken(token: String) {
        (application as PocketApplication).repository.registerFcmToken(token)
    }

    override fun onMessageReceived(message: RemoteMessage) {
        if (!getSharedPreferences("settings", MODE_PRIVATE).getBoolean("notifications", true)) return
        val type = message.data["type"].orEmpty()
        val sessionId = message.data["sessionId"].orEmpty()
        val completed = type == "turn.status"
        val manager = getSystemService(NotificationManager::class.java)
        manager.createNotificationChannel(NotificationChannel(CHANNEL, "Codex 任务提醒", NotificationManager.IMPORTANCE_DEFAULT))
        val intent = Intent(this, MainActivity::class.java)
            .addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP or Intent.FLAG_ACTIVITY_CLEAR_TOP)
        if (sessionId.isNotBlank()) intent.putExtra("threadId", sessionId)
        val pending = PendingIntent.getActivity(
            this, sessionId.hashCode(), intent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )
        manager.notify(
            message.data["eventId"].orEmpty().hashCode(),
            NotificationCompat.Builder(this, CHANNEL)
                .setSmallIcon(android.R.drawable.stat_notify_more)
                .setContentTitle(if (completed) "Codex 任务已完成" else "Codex 任务需要关注")
                .setContentText("打开 Agent Pocket 查看详情")
                .setContentIntent(pending)
                .setAutoCancel(true)
                .build(),
        )
    }

    companion object { private const val CHANNEL = "task_attention" }
}

package com.agentpocket.app

import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.os.IBinder
import androidx.core.app.NotificationCompat
import androidx.core.content.ContextCompat

class BridgeSyncService : Service() {
    override fun onCreate() {
        super.onCreate()
        val manager = getSystemService(NotificationManager::class.java)
        manager.createNotificationChannel(NotificationChannel(CHANNEL, "Codex 实时连接", NotificationManager.IMPORTANCE_LOW))
        val intent = PendingIntent.getActivity(
            this, 0, Intent(this, MainActivity::class.java),
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )
        startForeground(
            NOTIFICATION_ID,
            NotificationCompat.Builder(this, CHANNEL)
                .setSmallIcon(android.R.drawable.stat_notify_sync)
                .setContentTitle("Agent Pocket 已连接")
                .setContentText("正在通过加密中继接收 Codex 实时进度")
                .setContentIntent(intent)
                .setOngoing(true)
                .build(),
        )
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int) = START_STICKY
    override fun onBind(intent: Intent?): IBinder? = null

    override fun onTimeout(startId: Int, fgsType: Int) {
        (application as PocketApplication).repository.pauseForBackgroundLimit()
        stopSelf(startId)
    }

    companion object {
        private const val CHANNEL = "bridge_sync"
        private const val NOTIFICATION_ID = 1001
        fun start(context: Context) {
            runCatching { ContextCompat.startForegroundService(context, Intent(context, BridgeSyncService::class.java)) }
        }
    }
}

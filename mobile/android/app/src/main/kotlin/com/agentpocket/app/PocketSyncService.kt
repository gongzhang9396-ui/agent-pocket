package com.agentpocket.app

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.IBinder
import io.flutter.plugin.common.MethodChannel

class PocketSyncService : Service() {
    override fun onCreate() {
        super.onCreate()
        val manager = getSystemService(NotificationManager::class.java)
        manager.createNotificationChannel(NotificationChannel("bridge_sync", "Codex 实时连接", NotificationManager.IMPORTANCE_LOW))
        val open = PendingIntent.getActivity(this, 0, Intent(this, MainActivity::class.java), PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
        val notification = Notification.Builder(this, "bridge_sync").setSmallIcon(android.R.drawable.stat_notify_sync)
            .setContentTitle("Agent Pocket").setContentText("正在接收加密任务进度").setContentIntent(open).setOngoing(true).build()
        if (Build.VERSION.SDK_INT >= 29) startForeground(1001, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC)
        else startForeground(1001, notification)
    }
    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int = START_NOT_STICKY
    override fun onBind(intent: Intent?): IBinder? = null
    override fun onTimeout(startId: Int, fgsType: Int) {
        (application as PocketApplication).sharedEngine?.let {
            MethodChannel(it.dartExecutor.binaryMessenger, "agent_pocket/background").invokeMethod("timeout", null)
        }
        stopForeground(STOP_FOREGROUND_REMOVE)
        stopSelf(startId)
    }
    override fun onDestroy() {
        (application as PocketApplication).sharedEngine?.let {
            MethodChannel(it.dartExecutor.binaryMessenger, "agent_pocket/background").invokeMethod("stopped", null)
        }
        super.onDestroy()
    }
}

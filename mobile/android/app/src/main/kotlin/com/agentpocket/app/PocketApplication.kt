package com.agentpocket.app

import android.app.Application
import io.flutter.embedding.engine.FlutterEngine
import io.flutter.plugin.common.BinaryMessenger

/** One engine owns the session for both Activity and foreground service. */
class PocketApplication : Application() {
    val persistenceLock = Any()
    private var persistenceTaskQueue: BinaryMessenger.TaskQueue? = null
    var sharedEngine: FlutterEngine? = null
        private set
    fun engine(): FlutterEngine = sharedEngine ?: FlutterEngine(this).also { sharedEngine = it }
    fun persistenceQueue(engine: FlutterEngine): BinaryMessenger.TaskQueue = persistenceTaskQueue ?: engine.dartExecutor.binaryMessenger
        .makeBackgroundTaskQueue(BinaryMessenger.TaskQueueOptions().setIsSerial(true)).also { persistenceTaskQueue = it }
}

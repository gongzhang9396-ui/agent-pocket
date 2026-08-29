package com.agentpocket.app

import android.app.Application
import com.agentpocket.app.data.RpcPocketRepository
import com.google.firebase.FirebaseApp
import com.google.firebase.messaging.FirebaseMessaging

class PocketApplication : Application() {
    val repository by lazy { RpcPocketRepository(this) }

    override fun onCreate() {
        super.onCreate()
        val firebase = runCatching { FirebaseApp.initializeApp(this) }.getOrNull()
        repository
        if (firebase != null) FirebaseMessaging.getInstance().token.addOnSuccessListener(repository::registerFcmToken)
    }
}

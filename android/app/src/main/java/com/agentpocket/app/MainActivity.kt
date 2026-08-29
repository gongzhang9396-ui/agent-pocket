package com.agentpocket.app

import android.Manifest
import android.content.Intent
import android.os.Build
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf

class MainActivity : ComponentActivity() {
    private val notificationPermission = registerForActivityResult(ActivityResultContracts.RequestPermission()) {}
    private val launchRequest = mutableStateOf<LaunchRequest?>(null)
    private var launchSequence = 0L

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()
        acceptLaunchIntent(intent)
        val repo = (application as PocketApplication).repository
        if (Build.VERSION.SDK_INT >= 33) notificationPermission.launch(Manifest.permission.POST_NOTIFICATIONS)
        setContent {
            val request by launchRequest
            PocketApp(
                repo = repo,
                initialThreadId = request?.threadId,
                launchRequestKey = request?.sequence ?: 0L,
            )
        }
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        acceptLaunchIntent(intent)
    }

    override fun onStart() {
        super.onStart()
        (application as PocketApplication).repository.resume()
    }

    private fun acceptLaunchIntent(intent: Intent) {
        val threadId = intent.getStringExtra("threadId")?.takeIf { it.isNotBlank() } ?: return
        launchRequest.value = LaunchRequest(threadId, ++launchSequence)
    }
}

private data class LaunchRequest(val threadId: String, val sequence: Long)

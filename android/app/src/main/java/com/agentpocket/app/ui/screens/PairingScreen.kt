package com.agentpocket.app.ui.screens

import android.Manifest
import android.content.pm.PackageManager
import androidx.compose.foundation.border
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.filled.Lock
import androidx.compose.material.icons.filled.QrCodeScanner
import androidx.compose.material.icons.filled.Shield
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.FilterChip
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.camera.core.CameraSelector
import androidx.camera.core.ImageAnalysis
import androidx.camera.core.Preview as CameraPreview
import androidx.camera.lifecycle.ProcessCameraProvider
import androidx.camera.view.PreviewView
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.tooling.preview.Preview
import androidx.compose.ui.unit.dp
import androidx.compose.ui.viewinterop.AndroidView
import androidx.core.content.ContextCompat
import androidx.lifecycle.compose.LocalLifecycleOwner
import com.agentpocket.app.data.MockPocketRepository
import com.agentpocket.app.data.PocketRepository
import com.agentpocket.app.ui.components.ConnectionPill
import com.agentpocket.app.ui.theme.AgentPocketTheme
import com.google.mlkit.vision.barcode.BarcodeScanner
import com.google.mlkit.vision.barcode.BarcodeScanning
import com.google.mlkit.vision.barcode.BarcodeScannerOptions
import com.google.mlkit.vision.barcode.common.Barcode
import com.google.mlkit.vision.common.InputImage
import java.util.concurrent.Executors

/**
 * 配对页：解释 HTTPS 专用中继访问模型，提供相机扫码与手动配对两种入口。
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun PairingScreen(
    repo: PocketRepository,
    onPaired: () -> Unit,
    onBack: (() -> Unit)? = null,
) {
    val host by repo.host.collectAsState()
    val paired by repo.isPaired.collectAsState()
    var tab by rememberSaveable { mutableStateOf(0) }
    var wssUrl by rememberSaveable { mutableStateOf(host.wssUrl) }
    var pairingCode by rememberSaveable { mutableStateOf("") }
    LaunchedEffect(paired) { if (paired) onPaired() }

    Scaffold(
        topBar = {
            TopAppBar(
                title = { Text("连接到你的 Codex Bridge") },
                navigationIcon = {
                    if (onBack != null) {
                        IconButton(onClick = onBack) {
                            Icon(Icons.AutoMirrored.Filled.ArrowBack, contentDescription = "返回")
                        }
                    }
                },
            )
        },
    ) { padding ->
        Column(
            modifier = Modifier
                .fillMaxSize()
                .padding(padding)
                .verticalScroll(rememberScrollState())
                .padding(horizontal = 16.dp, vertical = 8.dp),
        ) {
            // HTTPS relay explanation
            Card(colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surface)) {
                Column(Modifier.padding(14.dp)) {
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        Icon(
                            Icons.Filled.Shield,
                            contentDescription = null,
                            tint = MaterialTheme.colorScheme.primary,
                            modifier = Modifier.size(18.dp),
                        )
                        Spacer(Modifier.width(8.dp))
                        Text("HTTPS 专用中继", style = MaterialTheme.typography.titleSmall)
                    }
                    Spacer(Modifier.height(8.dp))
                    RelayPoint("无需关闭手机现有 VPN；Windows 主动连接你的东京节点。")
                    RelayPoint("手机到中继使用 TLS，Bridge 始终只监听 Windows 回环地址。")
                    RelayPoint("设备令牌加密保存在系统 Keystore，配对码 5 分钟内有效。")
                }
            }

            Spacer(Modifier.height(16.dp))
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                FilterChip(
                    selected = tab == 0,
                    onClick = { tab = 0 },
                    label = { Text("扫码配对") },
                )
                FilterChip(
                    selected = tab == 1,
                    onClick = { tab = 1 },
                    label = { Text("手动配对") },
                )
            }
            Spacer(Modifier.height(14.dp))

            if (tab == 0) {
                QrScanPane(onScanned = repo::pairFromQr)
            } else {
                ManualPairPane(
                    wssUrl = wssUrl,
                    onWssUrlChange = { wssUrl = it },
                    pairingCode = pairingCode,
                    onPairingCodeChange = { pairingCode = it },
                    onConnect = {
                        repo.pairManually(wssUrl, pairingCode)
                    },
                )
            }

            Spacer(Modifier.height(20.dp))
            Row(
                Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.Center,
            ) {
                ConnectionPill(state = host.connectionState, relayName = host.relayName)
            }
            if (host.lastSeen.isNotBlank() && host.lastSeen != "尚未连接" && host.lastSeen != "刚刚") {
                Spacer(Modifier.height(8.dp))
                Text(
                    host.lastSeen,
                    modifier = Modifier.fillMaxWidth(),
                    style = MaterialTheme.typography.bodySmall,
                    color = if (host.connectionState == com.agentpocket.app.data.model.ConnectionState.Disconnected) {
                        MaterialTheme.colorScheme.error
                    } else {
                        MaterialTheme.colorScheme.onSurfaceVariant
                    },
                    textAlign = androidx.compose.ui.text.style.TextAlign.Center,
                )
            }
            Spacer(Modifier.height(24.dp))
        }
    }
}

@Composable
private fun RelayPoint(text: String) {
    Row(Modifier.padding(vertical = 3.dp)) {
        Icon(
            Icons.Filled.Lock,
            contentDescription = null,
            tint = MaterialTheme.colorScheme.onSurfaceVariant,
            modifier = Modifier
                .size(13.dp)
                .padding(top = 2.dp),
        )
        Spacer(Modifier.width(8.dp))
        Text(text, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
    }
}

@Composable
private fun QrScanPane(onScanned: (String) -> Unit) {
    val context = LocalContext.current
    var scanning by rememberSaveable { mutableStateOf(false) }
    var cameraGranted by remember { mutableStateOf(ContextCompat.checkSelfPermission(context, Manifest.permission.CAMERA) == PackageManager.PERMISSION_GRANTED) }
    var scanError by remember { mutableStateOf<String?>(null) }

    val permissionLauncher = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) { granted ->
        cameraGranted = granted
        if (granted) {
            scanError = null
            scanning = true
        } else {
            scanError = "相机权限被拒绝，请在系统设置中允许 Agent Pocket 使用相机"
        }
    }

    if (scanning) {
        CameraQrScanner(
            onScanned = {
                scanning = false
                onScanned(it)
            },
            onClose = { scanning = false },
            onError = { scanError = it; scanning = false },
        )
        return
    }

    Column(
        Modifier.fillMaxWidth(),
        horizontalAlignment = Alignment.CenterHorizontally,
    ) {
        Box(
            modifier = Modifier
                .size(220.dp)
                .border(1.dp, MaterialTheme.colorScheme.outline, RoundedCornerShape(16.dp)),
            contentAlignment = Alignment.Center,
        ) {
            Icon(
                Icons.Filled.QrCodeScanner,
                contentDescription = null,
                tint = MaterialTheme.colorScheme.onSurfaceVariant,
                modifier = Modifier.size(56.dp),
            )
        }
        Spacer(Modifier.height(12.dp))
        Text(
            "将取景框对准桌面端 Bridge 显示的二维码",
            style = MaterialTheme.typography.bodyMedium,
        )
        Spacer(Modifier.height(4.dp))
        Text(
            "二维码由桌面端 Bridge 生成，配对码 5 分钟内有效",
            style = MaterialTheme.typography.labelSmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
        Spacer(Modifier.height(12.dp))
        OutlinedButton(onClick = {
            if (!context.packageManager.hasSystemFeature(PackageManager.FEATURE_CAMERA_ANY)) {
                scanError = "这台设备没有可用相机"
            } else if (cameraGranted) {
                scanError = null
                scanning = true
            } else {
                permissionLauncher.launch(Manifest.permission.CAMERA)
            }
        }) {
            Text(if (cameraGranted) "开始扫描" else "授权相机并扫描")
        }
        scanError?.let { Text(it, style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.error) }
    }
}

@Composable
private fun CameraQrScanner(
    onScanned: (String) -> Unit,
    onClose: () -> Unit,
    onError: (String) -> Unit,
) {
    val context = LocalContext.current
    val lifecycleOwner = LocalLifecycleOwner.current
    val previewView = remember {
        PreviewView(context).apply { scaleType = PreviewView.ScaleType.FILL_CENTER }
    }
    val executor = remember { Executors.newSingleThreadExecutor() }

    DisposableEffect(lifecycleOwner) {
        val providerFuture = ProcessCameraProvider.getInstance(context)
        var provider: ProcessCameraProvider? = null
        var analysis: ImageAnalysis? = null
        var scanner: BarcodeScanner? = null
        var handled = false

        val listener = Runnable {
            runCatching {
                provider = providerFuture.get()
                val cameraProvider = provider ?: error("相机服务不可用")
                val preview = CameraPreview.Builder().build().also { it.setSurfaceProvider(previewView.surfaceProvider) }
                scanner = BarcodeScanning.getClient(
                    BarcodeScannerOptions.Builder().setBarcodeFormats(Barcode.FORMAT_QR_CODE).build(),
                )
                val imageAnalysis = ImageAnalysis.Builder()
                    .setBackpressureStrategy(ImageAnalysis.STRATEGY_KEEP_ONLY_LATEST)
                    .build()
                analysis = imageAnalysis
                imageAnalysis.setAnalyzer(executor) { imageProxy ->
                            val mediaImage = imageProxy.image
                            if (mediaImage == null || handled) {
                                imageProxy.close()
                            } else {
                                val image = InputImage.fromMediaImage(mediaImage, imageProxy.imageInfo.rotationDegrees)
                                scanner?.process(image)
                                    ?.addOnSuccessListener { codes ->
                                        val value = codes.firstNotNullOfOrNull { it.rawValue }.orEmpty()
                                        if (value.isNotBlank() && !handled) {
                                            handled = true
                                            previewView.post { onScanned(value) }
                                        }
                                    }
                                    ?.addOnCompleteListener { imageProxy.close() }
                                    ?: imageProxy.close()
                            }
                        }
                cameraProvider.unbindAll()
                cameraProvider.bindToLifecycle(
                    lifecycleOwner,
                    CameraSelector.DEFAULT_BACK_CAMERA,
                    preview,
                    imageAnalysis,
                )
            }.onFailure { error ->
                previewView.post { onError("相机启动失败：${error.message ?: "未知错误"}") }
            }
        }
        providerFuture.addListener(listener, ContextCompat.getMainExecutor(context))

        onDispose {
            analysis?.clearAnalyzer()
            provider?.unbindAll()
            scanner?.close()
            executor.shutdown()
        }
    }

    Box(
        Modifier
            .fillMaxWidth()
            .height(460.dp)
            .background(MaterialTheme.colorScheme.scrim),
    ) {
        AndroidView(factory = { previewView }, modifier = Modifier.fillMaxSize())
        Column(
            Modifier
                .align(Alignment.BottomCenter)
                .fillMaxWidth()
                .background(MaterialTheme.colorScheme.surface.copy(alpha = 0.9f))
                .padding(12.dp),
            horizontalAlignment = Alignment.CenterHorizontally,
        ) {
            Text("将二维码完整放入取景框", style = MaterialTheme.typography.bodyMedium)
            TextButton(onClick = onClose) { Text("取消扫描") }
        }
    }
}

@Composable
private fun ManualPairPane(
    wssUrl: String,
    onWssUrlChange: (String) -> Unit,
    pairingCode: String,
    onPairingCodeChange: (String) -> Unit,
    onConnect: () -> Unit,
) {
    Column {
        OutlinedTextField(
            value = wssUrl,
            onValueChange = onWssUrlChange,
            label = { Text("Bridge 地址（wss://）") },
            singleLine = true,
            textStyle = MaterialTheme.typography.bodySmall.copy(fontFamily = FontFamily.Monospace),
            modifier = Modifier.fillMaxWidth(),
        )
        Spacer(Modifier.height(10.dp))
        OutlinedTextField(
            value = pairingCode,
            onValueChange = onPairingCodeChange,
            label = { Text("配对码") },
            placeholder = { Text("桌面 Bridge 显示的完整配对码") },
            singleLine = true,
            textStyle = MaterialTheme.typography.bodyMedium.copy(fontFamily = FontFamily.Monospace),
            modifier = Modifier.fillMaxWidth(),
        )
        Spacer(Modifier.height(14.dp))
        Button(onClick = onConnect, modifier = Modifier.fillMaxWidth()) {
            Text("连接并配对")
        }
    }
}

@Preview(showBackground = true, backgroundColor = 0xFF0B0E13)
@Composable
private fun PairingScreenPreview() {
    AgentPocketTheme {
        PairingScreen(repo = MockPocketRepository, onPaired = {})
    }
}

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

$installDir = Split-Path -Parent $PSScriptRoot
$configPath = Join-Path $env:LOCALAPPDATA 'AgentPocket\host-config.json'
$identityPath = Join-Path $env:LOCALAPPDATA 'AgentPocket\relay-host.json'
$node = Join-Path $installDir 'node\node.exe'
$entry = Join-Path $installDir 'bridge\src\cli.ts'

if (-not (Test-Path -LiteralPath $configPath -PathType Leaf)) {
    [Windows.Forms.MessageBox]::Show('Agent Pocket Host 尚未配置，请重新运行安装程序。', 'Agent Pocket 配对助手', 'OK', 'Error') | Out-Null
    exit 1
}
$config = Get-Content -Raw -Encoding UTF8 -LiteralPath $configPath | ConvertFrom-Json
$relayUrl = [string]$config.relayUrl
$hostName = [string]$config.hostName
$env:AGENT_POCKET_RELAY_URL = $relayUrl
$env:AGENT_POCKET_HOST_NAME = $hostName
$env:AGENT_POCKET_RELAY_IDENTITY = $identityPath

$form = New-Object Windows.Forms.Form
$form.Text = 'Agent Pocket 配对助手'
$form.StartPosition = 'CenterScreen'
$form.ClientSize = New-Object Drawing.Size(480, 650)
$form.MinimumSize = New-Object Drawing.Size(496, 689)
$form.Font = New-Object Drawing.Font('Microsoft YaHei UI', 10)
$form.BackColor = [Drawing.Color]::FromArgb(245, 247, 250)

$title = New-Object Windows.Forms.Label
$title.Text = '连接这台 Windows 电脑'
$title.Font = New-Object Drawing.Font('Microsoft YaHei UI', 18, [Drawing.FontStyle]::Bold)
$title.AutoSize = $true
$title.Location = New-Object Drawing.Point(24, 20)
$form.Controls.Add($title)

$subtitle = New-Object Windows.Forms.Label
$subtitle.Text = '打开 Agent Pocket，扫描二维码后输入账号密码。首次登录会自动激活并绑定。'
$subtitle.ForeColor = [Drawing.Color]::FromArgb(82, 91, 103)
$subtitle.Location = New-Object Drawing.Point(26, 62)
$subtitle.Size = New-Object Drawing.Size(425, 44)
$form.Controls.Add($subtitle)

$picture = New-Object Windows.Forms.PictureBox
$picture.Location = New-Object Drawing.Point(70, 115)
$picture.Size = New-Object Drawing.Size(340, 340)
$picture.SizeMode = 'Zoom'
$picture.BackColor = [Drawing.Color]::White
$picture.BorderStyle = 'FixedSingle'
$form.Controls.Add($picture)

$statusLabel = New-Object Windows.Forms.Label
$statusLabel.Text = '正在检查绑定状态…'
$statusLabel.Font = New-Object Drawing.Font('Microsoft YaHei UI', 11, [Drawing.FontStyle]::Bold)
$statusLabel.Location = New-Object Drawing.Point(26, 472)
$statusLabel.Size = New-Object Drawing.Size(425, 30)
$form.Controls.Add($statusLabel)

$detailLabel = New-Object Windows.Forms.Label
$detailLabel.Text = "Relay：$relayUrl`r`n电脑：$hostName"
$detailLabel.ForeColor = [Drawing.Color]::FromArgb(82, 91, 103)
$detailLabel.Location = New-Object Drawing.Point(26, 505)
$detailLabel.Size = New-Object Drawing.Size(425, 50)
$form.Controls.Add($detailLabel)

$progress = New-Object Windows.Forms.ProgressBar
$progress.Location = New-Object Drawing.Point(28, 560)
$progress.Size = New-Object Drawing.Size(423, 8)
$progress.Style = 'Continuous'
$form.Controls.Add($progress)

$refreshButton = New-Object Windows.Forms.Button
$refreshButton.Text = '刷新二维码'
$refreshButton.Location = New-Object Drawing.Point(28, 585)
$refreshButton.Size = New-Object Drawing.Size(205, 42)
$refreshButton.Enabled = $false
$form.Controls.Add($refreshButton)

$closeButton = New-Object Windows.Forms.Button
$closeButton.Text = '关闭'
$closeButton.Location = New-Object Drawing.Point(246, 585)
$closeButton.Size = New-Object Drawing.Size(205, 42)
$form.Controls.Add($closeButton)

$script:enrollProcess = $null
$script:expiresAt = 0L
$script:completed = $false
$script:lastError = ''

function Set-QrImage([string]$Path) {
    if ([string]::IsNullOrWhiteSpace($Path) -or -not (Test-Path -LiteralPath $Path -PathType Leaf)) { return }
    $bytes = [IO.File]::ReadAllBytes($Path)
    $stream = New-Object IO.MemoryStream(,$bytes)
    try {
        $source = [Drawing.Image]::FromStream($stream)
        try { $image = New-Object Drawing.Bitmap($source) } finally { $source.Dispose() }
    } finally { $stream.Dispose() }
    if ($picture.Image) { $picture.Image.Dispose() }
    $picture.Image = $image
}

function Restart-AgentPocketHost {
    . (Join-Path $PSScriptRoot 'task-names.ps1')
    Stop-ScheduledTask -TaskName $AgentPocketHostTaskName -ErrorAction SilentlyContinue
    Start-ScheduledTask -TaskName $AgentPocketHostTaskName -ErrorAction SilentlyContinue
}

function Test-AlreadyEnrolled {
    try {
        $raw = (& $node --experimental-strip-types $entry relay-status --output ndjson 2>$null | Out-String).Trim()
        if (-not $raw) { return $false }
        return [bool](($raw | ConvertFrom-Json).enrolled)
    } catch { return $false }
}

$handleOutput = [Action[string]] {
    param([string]$line)
    try { $event = $line | ConvertFrom-Json } catch { return }
    switch ([string]$event.event) {
        'enrollment_started' {
            $script:expiresAt = [long]$event.expiresAt
            Set-QrImage ([string]$event.qrFile)
            $statusLabel.Text = '请用手机扫描二维码'
            $detailLabel.Text = "Relay：$relayUrl`r`n二维码将在 5 分钟后过期"
            $refreshButton.Enabled = $true
        }
        'enrollment_status' {
            if ([bool]$event.approved) { $statusLabel.Text = '手机已确认，正在完成绑定…' }
        }
        'enrollment_completed' {
            $script:completed = $true
            $script:expiresAt = 0
            $progress.Value = 100
            $statusLabel.Text = '绑定成功'
            $statusLabel.ForeColor = [Drawing.Color]::FromArgb(22, 125, 78)
            $detailLabel.Text = 'Agent Pocket Host 已启动。现在可以在手机上查看任务。'
            $refreshButton.Enabled = $false
            Restart-AgentPocketHost
        }
    }
}
$handleError = [Action[string]] { param([string]$line) $script:lastError = $line }

function Stop-EnrollmentProcess {
    if ($script:enrollProcess -and -not $script:enrollProcess.HasExited) {
        try { $script:enrollProcess.Kill() } catch {}
        try { [void]$script:enrollProcess.WaitForExit(2000) } catch {}
    }
    if ($script:enrollProcess) {
        try { $script:enrollProcess.CancelOutputRead() } catch {}
        try { $script:enrollProcess.CancelErrorRead() } catch {}
    }
    if ($script:enrollProcess) { $script:enrollProcess.Dispose() }
    $script:enrollProcess = $null
}

function Start-Enrollment {
    Stop-EnrollmentProcess
    $script:completed = $false
    $script:lastError = ''
    $script:expiresAt = 0
    $progress.Value = 0
    $statusLabel.ForeColor = [Drawing.Color]::FromArgb(32, 37, 44)
    $statusLabel.Text = '正在生成本地二维码…'
    $detailLabel.Text = "Relay：$relayUrl`r`n电脑：$hostName"
    $refreshButton.Enabled = $false

    $info = New-Object Diagnostics.ProcessStartInfo
    $info.FileName = $node
    $info.Arguments = "--experimental-strip-types `"$entry`" relay-enroll `"$relayUrl`" --output ndjson"
    $info.WorkingDirectory = $installDir
    $info.UseShellExecute = $false
    $info.CreateNoWindow = $true
    $info.RedirectStandardOutput = $true
    $info.RedirectStandardError = $true
    $process = New-Object Diagnostics.Process
    $process.StartInfo = $info
    $process.add_OutputDataReceived({
        param($sender, $eventArgs)
        if ($eventArgs.Data) { [void]$form.BeginInvoke($handleOutput, [object[]]@([string]$eventArgs.Data)) }
    })
    $process.add_ErrorDataReceived({
        param($sender, $eventArgs)
        if ($eventArgs.Data) { [void]$form.BeginInvoke($handleError, [object[]]@([string]$eventArgs.Data)) }
    })
    if (-not $process.Start()) { throw '无法启动配对进程。' }
    $script:enrollProcess = $process
    $process.BeginOutputReadLine()
    $process.BeginErrorReadLine()
}

$timer = New-Object Windows.Forms.Timer
$timer.Interval = 1000
$timer.add_Tick({
    if ($script:completed) { return }
    if ($script:expiresAt -gt 0) {
        $nowMs = [long](([DateTime]::UtcNow - [DateTime]'1970-01-01').TotalMilliseconds)
        $remaining = [Math]::Max(0, [long](($script:expiresAt - $nowMs) / 1000))
        $progress.Value = [Math]::Min(100, [Math]::Max(0, [int]((300 - $remaining) * 100 / 300)))
        $minutes = [int][Math]::Floor($remaining / 60)
        $seconds = [int]($remaining % 60)
        $detailLabel.Text = "Relay：$relayUrl`r`n二维码剩余 $minutes 分 $($seconds.ToString('00')) 秒"
        if ($remaining -eq 0) {
            $statusLabel.Text = '二维码已过期，请刷新'
            $statusLabel.ForeColor = [Drawing.Color]::FromArgb(185, 72, 45)
            $refreshButton.Enabled = $true
        }
    }
    if ($script:enrollProcess -and $script:enrollProcess.HasExited -and -not $script:completed) {
        $statusLabel.Text = if ($script:lastError) { $script:lastError } else { '配对未完成，请刷新二维码重试' }
        $statusLabel.ForeColor = [Drawing.Color]::FromArgb(185, 72, 45)
        $refreshButton.Enabled = $true
    }
})

$refreshButton.add_Click({ Start-Enrollment })
$closeButton.add_Click({ $form.Close() })
$form.add_FormClosed({
    $timer.Stop()
    Stop-EnrollmentProcess
    if ($picture.Image) { $picture.Image.Dispose() }
})
$form.add_Shown({
    if (Test-AlreadyEnrolled) {
        $script:completed = $true
        $progress.Value = 100
        $statusLabel.Text = '这台电脑已绑定'
        $statusLabel.ForeColor = [Drawing.Color]::FromArgb(22, 125, 78)
        $detailLabel.Text = "Relay：$relayUrl`r`nAgent Pocket Host 正常运行"
    } else {
        Start-Enrollment
    }
    $timer.Start()
})

[void]$form.ShowDialog()

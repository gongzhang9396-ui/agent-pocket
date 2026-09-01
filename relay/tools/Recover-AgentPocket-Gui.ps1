$ErrorActionPreference = 'Stop'

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

[System.Windows.Forms.Application]::EnableVisualStyles()
[System.Windows.Forms.Application]::SetCompatibleTextRenderingDefault($false)

$script:relayRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$script:process = $null
$script:timer = $null
$script:hostProcess = $null
$script:hostTimer = $null
$script:hostPairingStarted = $null
$script:hostQrPath = $null

function New-Label([string]$text) {
    $label = New-Object System.Windows.Forms.Label
    $label.Text = $text
    $label.AutoSize = $true
    $label.Anchor = 'Left'
    $label.Margin = New-Object System.Windows.Forms.Padding(0, 8, 8, 0)
    return $label
}

function New-TextBox([bool]$password = $false) {
    $box = New-Object System.Windows.Forms.TextBox
    $box.Dock = 'Fill'
    $box.Margin = New-Object System.Windows.Forms.Padding(0, 3, 0, 3)
    if ($password) { $box.UseSystemPasswordChar = $true }
    return $box
}

function Set-Status([string]$text, [bool]$error = $false) {
    $statusLabel.Text = $text
    $statusLabel.ForeColor = if ($error) { [Drawing.Color]::Firebrick } else { [Drawing.Color]::DimGray }
}

function Read-RecoveryFile([string]$path) {
    if (-not (Test-Path -LiteralPath $path -PathType Leaf)) { throw '恢复文件不存在。' }
    $value = Get-Content -Raw -LiteralPath $path | ConvertFrom-Json
    if ($value.version -ne 1 -or $value.algorithm -ne 'argon2id+xchacha20poly1305') {
        throw '恢复文件版本或加密算法不受支持。'
    }
    if (-not $value.accountId) { throw '恢复文件缺少 accountId。' }
    return $value
}

function Normalize-Relay([string]$value) {
    $uri = $null
    if (-not [Uri]::TryCreate($value.TrimEnd('/'), [UriKind]::Absolute, [ref]$uri) -or
        $uri.Scheme -ne 'https' -or $uri.UserInfo -or $uri.Fragment) {
        throw 'Relay 地址必须是 HTTPS 地址，例如 https://relay.example.com。'
    }
    return $uri.AbsoluteUri.TrimEnd('/')
}

function Get-NodePath {
    $bundled = Join-Path $script:relayRoot 'node\node.exe'
    if (Test-Path -LiteralPath $bundled -PathType Leaf) { return $bundled }
    $bridgeBundled = Join-Path $script:relayRoot '..\bridge\node\node.exe'
    if (Test-Path -LiteralPath $bridgeBundled -PathType Leaf) { return $bridgeBundled }
    $node = Get-Command node.exe -ErrorAction SilentlyContinue
    if ($node) { return $node.Source }
    throw '找不到 Node.js。请安装 Node.js 24，或从仓库根目录运行本工具。'
}

function Get-BridgeEntry {
    $source = Join-Path $script:relayRoot '..\bridge\src\cli.ts'
    if (Test-Path -LiteralPath $source -PathType Leaf) { return $source }
    $compiled = Join-Path $script:relayRoot '..\bridge\dist\cli.js'
    if (Test-Path -LiteralPath $compiled -PathType Leaf) { return $compiled }
    throw '找不到 Bridge 程序。请从 Agent Pocket Host 安装目录运行，或先完成 Host 安装。'
}

function Show-HostQr([string]$path) {
    if (-not (Test-Path -LiteralPath $path -PathType Leaf)) { return }
    $loaded = [Drawing.Image]::FromFile($path)
    $copy = New-Object Drawing.Bitmap($loaded)
    $loaded.Dispose()
    if ($hostQrBox.Image) { $hostQrBox.Image.Dispose() }
    $hostQrBox.Image = $copy
    $script:hostQrPath = $path
}

function Get-LatestHostQr {
    $localAppData = $env:LOCALAPPDATA
    if (-not $localAppData) { return $null }
    $dir = Join-Path $localAppData 'AgentPocket'
    if (-not (Test-Path -LiteralPath $dir -PathType Container)) { return $null }
    $candidate = Get-ChildItem -LiteralPath $dir -Filter 'pairing-*.png' -File -ErrorAction SilentlyContinue |
        Where-Object { $_.LastWriteTime -ge $script:hostPairingStarted } |
        Sort-Object LastWriteTime -Descending |
        Select-Object -First 1
    if ($candidate) { return $candidate.FullName }
    return $null
}

function Get-HostIdentityMetadata {
    $path = Join-Path $env:LOCALAPPDATA 'AgentPocket\relay-host.json'
    if (-not (Test-Path -LiteralPath $path -PathType Leaf)) { return $null }
    try { return Get-Content -Raw -Encoding UTF8 -LiteralPath $path | ConvertFrom-Json } catch { return $null }
}

function Clean-NodeDiagnostics([string]$text) {
    if ([string]::IsNullOrWhiteSpace($text)) { return '' }
    $lines = @($text -split "`r?`n" | Where-Object {
        $_ -notmatch '^\(node:\d+\) ExperimentalWarning:' -and
        $_ -notmatch '^\(Use `node --trace-warnings' -and
        $_ -notmatch 'SQLite is an experimental feature'
    })
    return ($lines -join [Environment]::NewLine).Trim()
}

function Start-HostEnrollment {
    try {
        if ($script:hostProcess -and -not $script:hostProcess.HasExited) { throw '主机绑定正在等待手机扫码，请先完成或关闭当前窗口。' }
        $existing = Get-HostIdentityMetadata
        if ($existing -and $existing.hostId -and $existing.accountId) {
            $hostStatusLabel.Text = "这台电脑已经绑定到账号 $($existing.accountId)，不需要再次扫码。请直接在手机端刷新或恢复设备。"
            $hostStatusLabel.ForeColor = [Drawing.Color]::DarkGreen
            return
        }
        $relay = Normalize-Relay $hostRelayBox.Text
        if ([string]::IsNullOrWhiteSpace($hostNameBox.Text)) { throw '请填写这台电脑的名称。' }
        $node = Get-NodePath
        $entry = Get-BridgeEntry
        $arguments = @()
        if ([IO.Path]::GetExtension($entry) -ieq '.ts') { $arguments += '--experimental-strip-types' }
        $arguments += @($entry, 'relay-enroll', $relay)

        $info = New-Object Diagnostics.ProcessStartInfo
        $info.FileName = $node
        if ($info.PSObject.Properties.Name -contains 'ArgumentList') {
            foreach ($argument in $arguments) { [void]$info.ArgumentList.Add([string]$argument) }
        } else {
            $info.Arguments = (($arguments | ForEach-Object { Quote-ProcessArgument $_ }) -join ' ')
        }
        $info.WorkingDirectory = [IO.Path]::GetFullPath((Join-Path $script:relayRoot '..\bridge'))
        $info.UseShellExecute = $false
        $info.CreateNoWindow = $true
        $info.RedirectStandardOutput = $true
        $info.RedirectStandardError = $true
        $info.EnvironmentVariables['AGENT_POCKET_RELAY_URL'] = $relay
        $info.EnvironmentVariables['AGENT_POCKET_HOST_NAME'] = $hostNameBox.Text.Trim()

        $script:hostPairingStarted = Get-Date
        $script:hostQrPath = $null
        if ($hostQrBox.Image) { $hostQrBox.Image.Dispose(); $hostQrBox.Image = $null }
        $script:hostProcess = New-Object Diagnostics.Process
        $script:hostProcess.StartInfo = $info
        if (-not $script:hostProcess.Start()) { throw '无法启动 Host 绑定程序。' }
        $hostStartButton.Enabled = $false
        $hostProgress.Style = 'Marquee'
        $hostStatusLabel.Text = '正在生成二维码，请稍候…'
        $hostStatusLabel.ForeColor = [Drawing.Color]::DimGray

        $script:hostTimer = New-Object System.Windows.Forms.Timer
        $script:hostTimer.Interval = 250
        $script:hostTimer.Add_Tick({
            if (-not $script:hostQrPath) {
                $qr = Get-LatestHostQr
                if ($qr) {
                    Show-HostQr $qr
                    $hostStatusLabel.Text = '二维码已显示。请在手机 Agent Pocket 中进入“绑定 Windows Host”并扫码确认。'
                }
            }
            if (-not $script:hostProcess.HasExited) { return }
            $script:hostTimer.Stop()
            $stdout = Clean-NodeDiagnostics $script:hostProcess.StandardOutput.ReadToEnd()
            $stderr = Clean-NodeDiagnostics $script:hostProcess.StandardError.ReadToEnd()
            $code = $script:hostProcess.ExitCode
            $script:hostProcess.Dispose()
            $script:hostProcess = $null
            $hostProgress.Style = 'Blocks'
            $hostStartButton.Enabled = $true
            if ($code -eq 0) {
                $hostStatusLabel.Text = 'Host 已绑定。手机现在可以看到这台电脑的任务。'
                $hostStatusLabel.ForeColor = [Drawing.Color]::DarkGreen
                [Windows.Forms.MessageBox]::Show($form, 'Host 绑定完成。现在可以回到手机刷新任务列表。', 'Agent Pocket', 'OK', 'Information') | Out-Null
            } else {
                $detail = if ($stderr) { $stderr } elseif ($stdout) { $stdout } else { "绑定程序退出码：$code" }
                $hostStatusLabel.Text = $detail
                $hostStatusLabel.ForeColor = [Drawing.Color]::Firebrick
                [Windows.Forms.MessageBox]::Show($form, $detail, 'Host 绑定失败', 'OK', 'Error') | Out-Null
            }
        })
        $script:hostTimer.Start()
    } catch {
        $hostStatusLabel.Text = $_.Exception.Message
        $hostStatusLabel.ForeColor = [Drawing.Color]::Firebrick
        [Windows.Forms.MessageBox]::Show($form, $_.Exception.Message, '无法开始 Host 绑定', 'OK', 'Warning') | Out-Null
    }
}

function Quote-ProcessArgument([string]$value) {
    if ($value -notmatch '[\s"]') { return $value }
    $escaped = $value -replace '(\\*)"', '$1$1\"'
    $escaped = $escaped -replace '(\\+)$', '$1$1'
    return '"' + $escaped + '"'
}

function Get-PendingDevices {
    [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
    $relay = Normalize-Relay $relayBox.Text
    if ([string]::IsNullOrWhiteSpace($accountBox.Text)) { throw '请先选择恢复 JSON 文件。' }
    if ([string]::IsNullOrWhiteSpace($adminUserBox.Text) -or [string]::IsNullOrWhiteSpace($adminPasswordBox.Text)) {
        throw '请填写管理员用户名和密码。'
    }

    $session = New-Object Microsoft.PowerShell.Commands.WebRequestSession
    $body = @{ username = $adminUserBox.Text.Trim(); password = $adminPasswordBox.Text } | ConvertTo-Json -Compress
    Invoke-RestMethod -Method Post -Uri "$relay/api/admin/login" -WebSession $session -ContentType 'application/json' -Body $body | Out-Null
    $accountId = [Uri]::EscapeDataString($accountBox.Text.Trim())
    $result = Invoke-RestMethod -Method Get -Uri "$relay/api/admin/users/$accountId/devices" -WebSession $session
    @($result.devices | Where-Object { $_.status -eq 'pending' })
}

function Validate-Form {
    $relay = Normalize-Relay $relayBox.Text
    if ([string]::IsNullOrWhiteSpace($accountBox.Text)) { throw '请先选择恢复 JSON 文件。' }
    if ([string]::IsNullOrWhiteSpace($deviceBox.Text) -or -not $deviceBox.SelectedItem) { throw '请先读取并选择待批准手机。' }
    if (-not (Test-Path -LiteralPath $fileBox.Text -PathType Leaf)) { throw '请选择有效的恢复 JSON 文件。' }
    if ([string]::IsNullOrWhiteSpace($adminUserBox.Text) -or [string]::IsNullOrWhiteSpace($adminPasswordBox.Text)) { throw '请填写管理员用户名和密码。' }
    if ([string]::IsNullOrWhiteSpace($passphraseBox.Text)) { throw '请填写离线恢复口令。' }
    return $relay
}

function Start-Recovery {
    try {
        $relay = Validate-Form
        $node = Get-NodePath
        $deviceId = [string]$deviceBox.SelectedItem.Id
        $arguments = @(
            (Join-Path $script:relayRoot 'dist\cli.js'),
            'recover-device',
            $relay,
            $accountBox.Text.Trim(),
            $deviceId,
            $fileBox.Text.Trim()
        )

        $info = New-Object Diagnostics.ProcessStartInfo
        $info.FileName = $node
        if ($info.PSObject.Properties.Name -contains 'ArgumentList') {
            foreach ($argument in $arguments) { [void]$info.ArgumentList.Add([string]$argument) }
        } else {
            $info.Arguments = (($arguments | ForEach-Object { Quote-ProcessArgument $_ }) -join ' ')
        }
        $info.WorkingDirectory = $script:relayRoot
        $info.UseShellExecute = $false
        $info.CreateNoWindow = $true
        $info.RedirectStandardOutput = $true
        $info.RedirectStandardError = $true
        $info.EnvironmentVariables['AGENT_POCKET_ADMIN_USERNAME'] = $adminUserBox.Text.Trim()
        $info.EnvironmentVariables['AGENT_POCKET_ADMIN_PASSWORD'] = $adminPasswordBox.Text
        $info.EnvironmentVariables['AGENT_POCKET_RECOVERY_PASSPHRASE'] = $passphraseBox.Text

        $script:process = New-Object Diagnostics.Process
        $script:process.StartInfo = $info
        if (-not $script:process.Start()) { throw '无法启动恢复程序。' }
        $recoverButton.Enabled = $false
        $loadDevicesButton.Enabled = $false
        $browseButton.Enabled = $false
        $progress.Style = 'Marquee'
        Set-Status '正在恢复设备，请不要关闭窗口…'

        $script:timer = New-Object System.Windows.Forms.Timer
        $script:timer.Interval = 250
        $script:timer.Add_Tick({
            if (-not $script:process.HasExited) { return }
            $script:timer.Stop()
            $stdout = $script:process.StandardOutput.ReadToEnd().Trim()
            $stderr = $script:process.StandardError.ReadToEnd().Trim()
            $code = $script:process.ExitCode
            $script:process.Dispose()
            $script:process = $null
            $progress.Style = 'Blocks'
            $recoverButton.Enabled = $true
            $loadDevicesButton.Enabled = $true
            $browseButton.Enabled = $true
            $passphraseBox.Text = ''
            $adminPasswordBox.Text = ''
            if ($code -eq 0) {
                Set-Status '设备恢复完成。请回到手机等待页面，等待几秒后会自动同步。'
                [Windows.Forms.MessageBox]::Show($form, '设备恢复完成。请回到手机，等待它自动变成“已批准”。', 'Agent Pocket', 'OK', 'Information') | Out-Null
            } else {
                $detail = if ($stderr) { $stderr } elseif ($stdout) { $stdout } else { "恢复程序退出码：$code" }
                Set-Status $detail $true
                [Windows.Forms.MessageBox]::Show($form, $detail, '恢复失败', 'OK', 'Error') | Out-Null
            }
        })
        $script:timer.Start()
    } catch {
        Set-Status $_.Exception.Message $true
        [Windows.Forms.MessageBox]::Show($form, $_.Exception.Message, '无法开始恢复', 'OK', 'Warning') | Out-Null
    }
}

$form = New-Object System.Windows.Forms.Form
$form.Text = 'Agent Pocket · 恢复手机设备'
$form.StartPosition = 'CenterScreen'
$form.Size = New-Object Drawing.Size(820, 650)
$form.MinimumSize = New-Object Drawing.Size(720, 560)
$form.Font = New-Object Drawing.Font('Microsoft YaHei UI', 10)
$form.BackColor = [Drawing.Color]::White

$tabs = New-Object System.Windows.Forms.TabControl
$tabs.Dock = 'Fill'
$recoveryPage = New-Object System.Windows.Forms.TabPage
$recoveryPage.Text = '恢复手机'
$hostPage = New-Object System.Windows.Forms.TabPage
$hostPage.Text = '绑定 Windows Host'
$tabs.TabPages.Add($recoveryPage)
$tabs.TabPages.Add($hostPage)
$form.Controls.Add($tabs)

$outer = New-Object System.Windows.Forms.TableLayoutPanel
$outer.Dock = 'Fill'
$outer.Padding = New-Object System.Windows.Forms.Padding(22)
$outer.ColumnCount = 1
$outer.RowCount = 3
$outer.RowStyles.Add((New-Object System.Windows.Forms.RowStyle('AutoSize')))
$outer.RowStyles.Add((New-Object System.Windows.Forms.RowStyle('Percent', 100)))
$outer.RowStyles.Add((New-Object System.Windows.Forms.RowStyle('AutoSize')))
$recoveryPage.Controls.Add($outer)

$title = New-Object System.Windows.Forms.Label
$title.Text = '恢复 Agent Pocket 手机设备'
$title.Font = New-Object Drawing.Font('Microsoft YaHei UI', 16, [Drawing.FontStyle]::Bold)
$title.AutoSize = $true
$title.Margin = New-Object System.Windows.Forms.Padding(0, 0, 0, 10)
$outer.Controls.Add($title, 0, 0)

$table = New-Object System.Windows.Forms.TableLayoutPanel
$table.Dock = 'Fill'
$table.AutoScroll = $true
$table.ColumnCount = 3
$table.RowCount = 9
$table.ColumnStyles.Add((New-Object System.Windows.Forms.ColumnStyle('Absolute', 150)))
$table.ColumnStyles.Add((New-Object System.Windows.Forms.ColumnStyle('Percent', 100)))
$table.ColumnStyles.Add((New-Object System.Windows.Forms.ColumnStyle('Absolute', 150)))
$outer.Controls.Add($table, 0, 1)

$relayBox = New-TextBox
$relayBox.Text = 'https://relay.example.com'
$accountBox = New-TextBox
$accountBox.ReadOnly = $true
$deviceBox = New-Object System.Windows.Forms.ComboBox
$deviceBox.Dock = 'Fill'
$deviceBox.DropDownStyle = 'DropDownList'
$deviceBox.DisplayMember = 'Label'
$fileBox = New-TextBox
$fileBox.ReadOnly = $true
$browseButton = New-Object System.Windows.Forms.Button
$browseButton.Text = '选择恢复文件…'
$browseButton.AutoSize = $true
$loadDevicesButton = New-Object System.Windows.Forms.Button
$loadDevicesButton.Text = '读取待批准设备'
$loadDevicesButton.AutoSize = $true
$adminUserBox = New-TextBox
$adminPasswordBox = New-TextBox $true
$passphraseBox = New-TextBox $true

$rows = @(
    @('Relay 地址', $relayBox, $null),
    @('账户 ID', $accountBox, $null),
    @('待批准手机', $deviceBox, $loadDevicesButton),
    @('恢复 JSON', $fileBox, $browseButton),
    @('管理员用户名', $adminUserBox, $null),
    @('管理员密码', $adminPasswordBox, $null),
    @('离线恢复口令', $passphraseBox, $null)
)
for($row = 0; $row -lt $rows.Count; $row++) {
    $table.RowStyles.Add((New-Object System.Windows.Forms.RowStyle('AutoSize')))
    $table.Controls.Add((New-Label $rows[$row][0]), 0, $row)
    $table.Controls.Add($rows[$row][1], 1, $row)
    if ($rows[$row][2]) { $table.Controls.Add($rows[$row][2], 2, $row) }
}

$hint = New-Object System.Windows.Forms.Label
$hint.Text = '恢复文件只在本机读取；Relay 不会收到恢复私钥。恢复成功后不要再次扫描 Windows Host。'
$hint.AutoSize = $true
$hint.ForeColor = [Drawing.Color]::DimGray
$hint.Margin = New-Object System.Windows.Forms.Padding(0, 12, 0, 0)
$table.Controls.Add($hint, 0, $rows.Count)
$table.SetColumnSpan($hint, 3)

$progress = New-Object System.Windows.Forms.ProgressBar
$progress.Dock = 'Fill'
$progress.Style = 'Blocks'
$progress.Visible = $true
$table.Controls.Add($progress, 0, $rows.Count + 1)
$table.SetColumnSpan($progress, 3)

$bottom = New-Object System.Windows.Forms.TableLayoutPanel
$bottom.Dock = 'Fill'
$bottom.ColumnCount = 2
$bottom.ColumnStyles.Add((New-Object System.Windows.Forms.ColumnStyle('Percent', 100)))
$bottom.ColumnStyles.Add((New-Object System.Windows.Forms.ColumnStyle('Absolute', 180)))
$outer.Controls.Add($bottom, 0, 2)

$statusLabel = New-Object System.Windows.Forms.Label
$statusLabel.Text = '请选择恢复 JSON 文件，然后读取待批准设备。'
$statusLabel.AutoSize = $true
$statusLabel.MaximumSize = New-Object Drawing.Size(590, 0)
$statusLabel.Margin = New-Object System.Windows.Forms.Padding(0, 10, 12, 0)
$bottom.Controls.Add($statusLabel, 0, 0)

$recoverButton = New-Object System.Windows.Forms.Button
$recoverButton.Text = '恢复设备'
$recoverButton.Height = 38
$recoverButton.Dock = 'Fill'
$recoverButton.BackColor = [Drawing.Color]::FromArgb(31, 111, 235)
$recoverButton.ForeColor = [Drawing.Color]::White
$recoverButton.FlatStyle = 'Flat'
$bottom.Controls.Add($recoverButton, 1, 0)

$hostLayout = New-Object System.Windows.Forms.TableLayoutPanel
$hostLayout.Dock = 'Fill'
$hostLayout.Padding = New-Object System.Windows.Forms.Padding(22)
$hostLayout.ColumnCount = 2
$hostLayout.RowCount = 8
$hostLayout.ColumnStyles.Add((New-Object System.Windows.Forms.ColumnStyle('Absolute', 150)))
$hostLayout.ColumnStyles.Add((New-Object System.Windows.Forms.ColumnStyle('Percent', 100)))
$hostLayout.RowStyles.Add((New-Object System.Windows.Forms.RowStyle('AutoSize')))
$hostLayout.RowStyles.Add((New-Object System.Windows.Forms.RowStyle('AutoSize')))
$hostLayout.RowStyles.Add((New-Object System.Windows.Forms.RowStyle('AutoSize')))
$hostLayout.RowStyles.Add((New-Object System.Windows.Forms.RowStyle('AutoSize')))
$hostLayout.RowStyles.Add((New-Object System.Windows.Forms.RowStyle('Percent', 100)))
$hostLayout.RowStyles.Add((New-Object System.Windows.Forms.RowStyle('AutoSize')))
$hostLayout.RowStyles.Add((New-Object System.Windows.Forms.RowStyle('AutoSize')))
$hostLayout.RowStyles.Add((New-Object System.Windows.Forms.RowStyle('AutoSize')))
$hostPage.Controls.Add($hostLayout)

$hostTitle = New-Object System.Windows.Forms.Label
$hostTitle.Text = '绑定这台 Windows Host'
$hostTitle.Font = New-Object Drawing.Font('Microsoft YaHei UI', 16, [Drawing.FontStyle]::Bold)
$hostTitle.AutoSize = $true
$hostTitle.Margin = New-Object System.Windows.Forms.Padding(0, 0, 0, 10)
$hostLayout.Controls.Add($hostTitle, 0, 0)
$hostLayout.SetColumnSpan($hostTitle, 2)

$hostRelayBox = New-TextBox
$hostRelayBox.Text = 'https://relay.example.com'
$hostNameBox = New-TextBox
$hostNameBox.Text = $env:COMPUTERNAME
$hostLayout.Controls.Add((New-Label 'Relay 地址'), 0, 1)
$hostLayout.Controls.Add($hostRelayBox, 1, 1)
$hostLayout.Controls.Add((New-Label '电脑名称'), 0, 2)
$hostLayout.Controls.Add($hostNameBox, 1, 2)

$hostHint = New-Object System.Windows.Forms.Label
$hostHint.Text = '点击下面的按钮后，二维码会直接显示在这里。手机端扫码并确认后，这台电脑会自动完成绑定。二维码 5 分钟后失效。'
$hostHint.AutoSize = $true
$hostHint.MaximumSize = New-Object Drawing.Size(680, 0)
$hostHint.ForeColor = [Drawing.Color]::DimGray
$hostHint.Margin = New-Object System.Windows.Forms.Padding(0, 12, 0, 8)
$hostLayout.Controls.Add($hostHint, 0, 3)
$hostLayout.SetColumnSpan($hostHint, 2)

$hostQrBox = New-Object System.Windows.Forms.PictureBox
$hostQrBox.Size = New-Object Drawing.Size(380, 380)
$hostQrBox.SizeMode = 'Zoom'
$hostQrBox.BorderStyle = 'FixedSingle'
$hostQrBox.BackColor = [Drawing.Color]::White
$hostQrBox.Anchor = 'Top'
$hostLayout.Controls.Add($hostQrBox, 0, 4)
$hostLayout.SetColumnSpan($hostQrBox, 2)

$hostProgress = New-Object System.Windows.Forms.ProgressBar
$hostProgress.Dock = 'Fill'
$hostProgress.Style = 'Blocks'
$hostLayout.Controls.Add($hostProgress, 0, 5)
$hostLayout.SetColumnSpan($hostProgress, 2)

$hostStatusLabel = New-Object System.Windows.Forms.Label
$hostStatusLabel.Text = '尚未开始绑定。'
$hostStatusLabel.AutoSize = $true
$hostStatusLabel.Dock = 'Fill'
$hostStatusLabel.MaximumSize = New-Object Drawing.Size(700, 0)
$hostStatusLabel.Margin = New-Object System.Windows.Forms.Padding(0, 10, 12, 0)
$hostLayout.Controls.Add($hostStatusLabel, 0, 6)
$hostLayout.SetColumnSpan($hostStatusLabel, 2)

$hostStartButton = New-Object System.Windows.Forms.Button
$hostStartButton.Text = '生成二维码并等待扫码'
$hostStartButton.Height = 38
$hostStartButton.Dock = 'Fill'
$hostStartButton.BackColor = [Drawing.Color]::FromArgb(31, 111, 235)
$hostStartButton.ForeColor = [Drawing.Color]::White
$hostStartButton.FlatStyle = 'Flat'
$hostLayout.Controls.Add($hostStartButton, 1, 7)

$hostConfigPath = Join-Path $env:LOCALAPPDATA 'AgentPocket\host-config.json'
if (Test-Path -LiteralPath $hostConfigPath -PathType Leaf) {
    try {
        $hostConfig = Get-Content -Raw -Encoding UTF8 -LiteralPath $hostConfigPath | ConvertFrom-Json
        if ($hostConfig.relayUrl) { $hostRelayBox.Text = [string]$hostConfig.relayUrl }
        if ($hostConfig.hostName) { $hostNameBox.Text = [string]$hostConfig.hostName }
    } catch {
        # 配置损坏时保留默认值，用户可以直接在界面中修正。
    }
}
$existingHost = Get-HostIdentityMetadata
if ($existingHost -and $existingHost.hostId -and $existingHost.accountId) {
    $hostStatusLabel.Text = "这台电脑已经绑定到账号 $($existingHost.accountId)，无需再次扫码。"
    $hostStatusLabel.ForeColor = [Drawing.Color]::DarkGreen
}

$browseButton.Add_Click({
    $dialog = New-Object System.Windows.Forms.OpenFileDialog
    $dialog.Filter = 'Agent Pocket 恢复文件 (*.json)|*.json|JSON 文件 (*.json)|*.json|所有文件 (*.*)|*.*'
    $dialog.Multiselect = $false
    if ($dialog.ShowDialog($form) -ne 'OK') { return }
    try {
        $value = Read-RecoveryFile $dialog.FileName
        $fileBox.Text = $dialog.FileName
        $accountBox.Text = [string]$value.accountId
        $deviceBox.Items.Clear()
        Set-Status '恢复文件已加载。请填写管理员账号密码，然后读取待批准设备。'
    } catch {
        Set-Status $_.Exception.Message $true
        [Windows.Forms.MessageBox]::Show($form, $_.Exception.Message, '恢复文件无效', 'OK', 'Warning') | Out-Null
    }
})

$loadDevicesButton.Add_Click({
    try {
        $loadDevicesButton.Enabled = $false
        Set-Status '正在读取 Relay 上的待批准设备…'
        $pending = @(Get-PendingDevices)
        $deviceBox.Items.Clear()
        foreach ($device in $pending) {
            $item = [PSCustomObject]@{ Id = [string]$device.id; Label = "$($device.name) · $($device.id)" }
            [void]$deviceBox.Items.Add($item)
        }
        if ($pending.Count -eq 0) { throw '没有找到待批准设备。请先在手机上重新登录 Relay。' }
        $deviceBox.SelectedIndex = 0
        Set-Status "已找到 $($pending.Count) 个待批准设备，请确认后点击“恢复设备”。"
    } catch {
        Set-Status $_.Exception.Message $true
        [Windows.Forms.MessageBox]::Show($form, $_.Exception.Message, '读取设备失败', 'OK', 'Warning') | Out-Null
    } finally {
        $loadDevicesButton.Enabled = $true
    }
})

$recoverButton.Add_Click({ Start-Recovery })
$hostStartButton.Add_Click({ Start-HostEnrollment })
$form.Add_FormClosed({
    if ($script:timer) { $script:timer.Stop(); $script:timer.Dispose() }
    if ($script:process) {
        if (-not $script:process.HasExited) { $script:process.Kill() }
        $script:process.Dispose()
    }
    if ($script:hostTimer) { $script:hostTimer.Stop(); $script:hostTimer.Dispose() }
    if ($script:hostProcess) {
        if (-not $script:hostProcess.HasExited) { $script:hostProcess.Kill() }
        $script:hostProcess.Dispose()
    }
    if ($hostQrBox.Image) { $hostQrBox.Image.Dispose() }
})

[void]$form.ShowDialog()

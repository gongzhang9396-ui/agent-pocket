$AgentPocketCurrentSid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
$script:AgentPocketHostTaskName = "Agent Pocket Host v2 $AgentPocketCurrentSid"
$script:AgentPocketUpdateTaskName = "Agent Pocket Host Update $AgentPocketCurrentSid"
$script:AgentPocketLegacyHostTaskName = 'Agent Pocket Host v2'

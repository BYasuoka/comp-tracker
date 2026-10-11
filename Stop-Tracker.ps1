param([int]$Port=8765)
$ErrorActionPreference='Stop'
$access=[IO.File]::ReadAllText("$PSScriptRoot\data\access-key.txt").Trim()
Invoke-RestMethod -Uri "http://127.0.0.1:$Port/api/shutdown" -Method Post -Headers @{'X-Access-Key'=$access} -ContentType 'application/json' -Body '{}' | Out-Null
Write-Host 'Comp Tracker stopped. Your data is saved.'

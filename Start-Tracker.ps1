param([int]$Port=8765,[string]$Bind='127.0.0.1',[string]$DataDirectory='', [switch]$ImportOnly,[string]$WebDirectory='')
$ErrorActionPreference='Stop'
. (Join-Path $PSScriptRoot 'Core.ps1')
if (!$WebDirectory) { $WebDirectory=Join-Path $PSScriptRoot 'web' }
if ($env:PORT) { $Port=[int]$env:PORT }
if ($env:TRACKER_BIND) { $Bind=$env:TRACKER_BIND }
if ($env:TRACKER_DATA) { $DataDirectory=$env:TRACKER_DATA }
if (!$DataDirectory) { $DataDirectory=Join-Path $PSScriptRoot 'data' }
$script:StorePath=Join-Path $DataDirectory 'tracker.json'
[IO.Directory]::CreateDirectory($DataDirectory) | Out-Null
$storeLock=[IO.File]::Open((Join-Path $DataDirectory 'server.lock'),'OpenOrCreate','ReadWrite','None')
$db=Load-Store
if ($env:TRACKER_SOURCE) { $db.source=$env:TRACKER_SOURCE; [IO.Directory]::CreateDirectory($db.source) | Out-Null }
if ($ImportOnly -or !$db.importedAt) { Import-Timesheets $db; Save-Store $db }
if ($ImportOnly) { $db.importLog | ForEach-Object { [pscustomobject]$_ } | Format-Table status,message,file -AutoSize; exit }
if ($Port -lt 1024 -or $Port -gt 65535) { throw 'Port must be between 1024 and 65535.' }
$ip=[Net.IPAddress]::Parse($Bind)
$tokenPath=Join-Path $DataDirectory 'access-key.txt'
if (!(Test-Path -LiteralPath $tokenPath)) {
    $bytes=New-Object byte[] 32; $rng=[Security.Cryptography.RandomNumberGenerator]::Create(); $rng.GetBytes($bytes); $rng.Dispose()
    [IO.File]::WriteAllText($tokenPath,([BitConverter]::ToString($bytes)).Replace('-','').ToLowerInvariant())
}
$token=if ($env:TRACKER_ACCESS_KEY) { $env:TRACKER_ACCESS_KEY.Trim() } else { [IO.File]::ReadAllText($tokenPath).Trim() }
if ($token.Length -lt 32) { throw 'Access key must be at least 32 characters.' }
# TcpListener avoids administrator-only HTTP URL reservations. One local user, serial durable writes.
$listener=[Net.Sockets.TcpListener]::new($ip,$Port); $listener.Start()
Write-Host "Comp Tracker: http://${Bind}:$Port"
Write-Host "Access key is in $tokenPath"
Write-Host 'Leave this process running. Ctrl+C stops the server.'
try {
    $stopping=$false
    while (!$stopping) {
        $client=$listener.AcceptTcpClient(); $client.ReceiveTimeout=10000; $client.SendTimeout=10000
        $net=$client.GetStream()
        try {
            $header=[Collections.Generic.List[byte]]::new()
            while ($true) {
                $b=$net.ReadByte(); if ($b -lt 0) { throw 'Incomplete request' }; $header.Add([byte]$b)
                $n=$header.Count
                if ($n -gt 16384) { throw 'Headers too large' }
                if ($n -ge 4 -and $header[$n-4] -eq 13 -and $header[$n-3] -eq 10 -and $header[$n-2] -eq 13 -and $header[$n-1] -eq 10) { break }
            }
            $lines=[Text.Encoding]::ASCII.GetString($header.ToArray()).Split(@("`r`n"),[StringSplitOptions]::None)
            $request=$lines[0].Split(' '); $method=$request[0]; $path=$request[1].Split('?')[0]; $headers=@{}
            foreach ($line in $lines | Select-Object -Skip 1) { $pos=$line.IndexOf(':'); if ($pos -gt 0) { $headers[$line.Substring(0,$pos).ToLowerInvariant()]=$line.Substring($pos+1).Trim() } }
            $length=0
            if ($headers.ContainsKey('content-length')) { $length=[int]$headers['content-length'] }
            if ($length -lt 0 -or $length -gt 17825792 -or $headers.ContainsKey('transfer-encoding')) { throw 'Unsupported request body' }
            $bodyBytes=New-Object byte[] $length; $offset=0
            while ($offset -lt $length) { $read=$net.Read($bodyBytes,$offset,$length-$offset); if ($read -le 0) { throw 'Incomplete body' }; $offset+=$read }
            $status=200; $type='application/json; charset=utf-8'; $payload=''; $extra=''
            if ($path.StartsWith('/api/') -and $headers['x-access-key'] -ne $token) { $status=401; $payload='{"error":"Enter the access key from data/access-key.txt."}' }
            elseif ($path -eq '/api/data' -and $method -eq 'GET') { $payload=$db | ConvertTo-Json -Depth 40 -Compress }
            elseif ($path -eq '/api/shutdown' -and $method -eq 'POST') { $stopping=$true; $payload='{"ok":true}' }
            elseif ($path -eq '/api/backup' -and $method -eq 'GET') { $payload=$db | ConvertTo-Json -Depth 40; $extra="Content-Disposition: attachment; filename=comp-tracker-backup.json`r`n" }
            elseif ($path.StartsWith('/api/') -and $method -eq 'POST') {
                try {
                    $body=[Text.Encoding]::UTF8.GetString($bodyBytes) | ConvertFrom-Json
                    # Apply changes to a copy; validation/write failures cannot mutate the live state.
                    $next=$db | ConvertTo-Json -Depth 40 | ConvertFrom-Json
                    Apply-Change $next $path.Substring(5) $body
                    Save-Store $next; $db=$next; $payload='{"ok":true}'
                } catch { $status=400; $payload=@{error=$_.Exception.Message} | ConvertTo-Json -Compress }
            }
            elseif ($method -eq 'GET' -and $path -in @('/','/app.js','/style.css','/health','/github-store.js','/model.mjs','/workbook.mjs')) {
                switch ($path) {
                    '/' { $type='text/html; charset=utf-8'; $payload=[IO.File]::ReadAllText((Join-Path $WebDirectory 'index.html')) }
                    '/app.js' { $type='application/javascript; charset=utf-8'; $payload=[IO.File]::ReadAllText((Join-Path $WebDirectory 'app.js')) }
                    '/style.css' { $type='text/css; charset=utf-8'; $payload=[IO.File]::ReadAllText((Join-Path $WebDirectory 'style.css')) }
                    '/health' { $payload='{"ok":true}' }
                    default { $type='application/javascript; charset=utf-8'; $asset=Join-Path $WebDirectory $path.TrimStart('/'); if ([IO.File]::Exists($asset)) { $payload=[IO.File]::ReadAllText($asset) } else { $status=404; $payload='' } }
                }
            } else { $status=404; $payload='{"error":"Not found"}' }
            $out=[Text.Encoding]::UTF8.GetBytes($payload)
            $response="HTTP/1.1 $status Response`r`nContent-Type: $type`r`nContent-Length: $($out.Length)`r`nConnection: close`r`nCache-Control: no-store`r`nX-Content-Type-Options: nosniff`r`nReferrer-Policy: no-referrer`r`nContent-Security-Policy: default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self' https://api.github.com; frame-ancestors 'none'; base-uri 'none'; form-action 'self'`r`n${extra}`r`n"
            $head=[Text.Encoding]::ASCII.GetBytes($response); $net.Write($head,0,$head.Length); $net.Write($out,0,$out.Length)
        } catch { Write-Warning $_.Exception.Message }
        finally { $net.Dispose(); $client.Dispose() }
    }
} finally { $listener.Stop(); $storeLock.Dispose() }

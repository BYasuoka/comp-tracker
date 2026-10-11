$ErrorActionPreference='Stop'
$out=Join-Path $PSScriptRoot 'dist'
[IO.Directory]::CreateDirectory($out) | Out-Null
foreach($name in @('app.js','style.css')) { Copy-Item -LiteralPath (Join-Path $PSScriptRoot "web/$name") -Destination (Join-Path $out $name) -Force }
foreach($name in @('github-store.js','model.mjs','workbook.mjs')) { Copy-Item -LiteralPath (Join-Path $PSScriptRoot "github/$name") -Destination (Join-Path $out $name) -Force }
$html=[IO.File]::ReadAllText((Join-Path $PSScriptRoot 'web/index.html'))
$html=$html.Replace('href="/style.css"','href="./style.css"').Replace('<script defer src="/app.js"></script>','<script defer src="./github-store.js"></script><script defer src="./app.js"></script>')
$html=$html.Replace('<title>Comp Tracker</title>','<title>Comp Tracker</title><meta name="referrer" content="no-referrer"><meta http-equiv="Content-Security-Policy" content="default-src ''self''; script-src ''self''; style-src ''self''; connect-src ''self'' https://api.github.com; base-uri ''none''; form-action ''none''">')
[IO.File]::WriteAllText((Join-Path $out 'index.html'),$html,[Text.UTF8Encoding]::new($false))
[IO.File]::WriteAllText((Join-Path $out '.nojekyll'),'')
Write-Output 'Built GitHub Pages static files in dist (no private records included).'

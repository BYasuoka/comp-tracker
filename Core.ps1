$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.IO.Compression
Add-Type -AssemblyName System.IO.Compression.FileSystem
$script:Invariant = [Globalization.CultureInfo]::InvariantCulture
function Number($v) {
    if ($null -eq $v -or [string]$v -eq '' -or [string]$v -eq '-') { return $null }
    $n = 0.0
    if ([double]::TryParse([string]$v, [Globalization.NumberStyles]::Float, $script:Invariant, [ref]$n) -and ![double]::IsNaN($n) -and ![double]::IsInfinity($n)) { return $n }
    return $null
}
function Hash-Text([string]$s) {
    $sha = [Security.Cryptography.SHA256]::Create()
    try { return ([BitConverter]::ToString($sha.ComputeHash([Text.Encoding]::UTF8.GetBytes($s)))).Replace('-','').ToLowerInvariant() } finally { $sha.Dispose() }
}
function Read-Book([string]$path) {
    # Take a read-only in-memory snapshot, including files shared by Excel.
    $stream = [IO.File]::Open($path, 'Open', 'Read', [IO.FileShare]::ReadWrite)
    $mem = [IO.MemoryStream]::new()
    try { $stream.CopyTo($mem) } finally { $stream.Dispose() }
    $sha = [Security.Cryptography.SHA256]::Create()
    $hash = ([BitConverter]::ToString($sha.ComputeHash($mem.ToArray()))).Replace('-','').ToLowerInvariant()
    $sha.Dispose(); $mem.Position = 0
    $zip = [IO.Compression.ZipArchive]::new($mem, [IO.Compression.ZipArchiveMode]::Read)
    function Part([string]$name) {
        $e = $zip.GetEntry($name)
        if (!$e) { return $null }
        $r = [IO.StreamReader]::new($e.Open())
        try {
            $settings = [Xml.XmlReaderSettings]::new(); $settings.DtdProcessing = 'Prohibit'; $settings.XmlResolver = $null
            $xr = [Xml.XmlReader]::Create($r, $settings)
            $doc = [xml]::new(); $doc.XmlResolver = $null; $doc.Load($xr); $xr.Dispose(); return $doc
        } finally { $r.Dispose() }
    }
    try {
        if ($zip.Entries.Count -gt 10000 -or ($zip.Entries | Measure-Object Length -Sum).Sum -gt 134217728) { throw 'Workbook expands beyond the supported size.' }
        $strings = @((Part 'xl/sharedStrings.xml').sst.si | ForEach-Object { $_.InnerText })
        $book = Part 'xl/workbook.xml'; $rels = Part 'xl/_rels/workbook.xml.rels'
        $sheets = @{}
        foreach ($s in $book.workbook.sheets.sheet) {
            $rid = $s.GetAttribute('id','http://schemas.openxmlformats.org/officeDocument/2006/relationships')
            $target = ($rels.Relationships.Relationship | Where-Object Id -eq $rid).Target
            $partName = if ($target.StartsWith('/')) { $target.TrimStart('/') } else { 'xl/' + $target }
            $xml = Part $partName; $cells = @{}; $formulas = @{}; $errors = @()
            foreach ($c in $xml.worksheet.sheetData.row.c) {
                if ($null -eq $c) { continue }
                $v = [string]$c.v
                if ($c.t -eq 's') { $v = $strings[[int]$v] }
                if ($c.t -eq 'inlineStr') { $v = $c.is.InnerText }
                $cells[[string]$c.r] = $v
                if ($c.SelectSingleNode('*[local-name()="f"]')) { $formulas[[string]$c.r] = $true }
                if ($c.t -eq 'e') { $errors += [string]$c.r }
            }
            # Carry labels through their actual merged range, never across unrelated rows.
            foreach ($m in $xml.worksheet.mergeCells.mergeCell) {
                if ($m.ref -match '^([AB])(\d+):\1(\d+)$') {
                    $col=$Matches[1]; $first=[int]$Matches[2]; $last=[int]$Matches[3]
                    for ($i=$first+1; $i -le $last; $i++) { $cells["$col$i"] = $cells["$col$first"] }
                }
            }
            $sheets[[string]$s.name] = @{ cells=$cells; formulas=$formulas; errors=$errors }
        }
        return @{ hash=$hash; sheets=$sheets; date1904=([string]$book.workbook.workbookPr.date1904 -in @('1','true')) }
    } finally { $zip.Dispose(); $mem.Dispose() }
}
function Find-Row($cells,[string]$column,[string]$pattern) {
    $found = @($cells.Keys | Where-Object { $_ -match "^$column\d+$" -and [string]$cells[$_] -match $pattern } | ForEach-Object { [int]($_ -replace '\D','') } | Sort-Object)
    if ($found.Count) { return $found[0] }; return $null
}
function Project-Code($value) {
    $s=([string]$value).Trim().ToUpperInvariant()
    if ($s -match '^P\d+(?:-[A-Z0-9]+)*$') { return $s }
    return 'UNASSIGNED'
}
function New-Store {
    $source=if ($env:TRACKER_SOURCE) { $env:TRACKER_SOURCE } else { Join-Path $HOME 'Documents/Timesheet' }
    return [pscustomobject]@{ version=1; source=$source; importedAt=$null; weeks=@(); projects=@(); payments=@(); manualClaims=@(); assignments=@(); selections=@(); importLog=@(); audit=@() }
}
function Save-Store($db) {
    $dir=Split-Path $script:StorePath
    [IO.Directory]::CreateDirectory($dir) | Out-Null
    $tmp=$script:StorePath+'.tmp'
    [IO.File]::WriteAllText($tmp, ($db | ConvertTo-Json -Depth 40), [Text.UTF8Encoding]::new($false))
    if ([IO.File]::Exists($script:StorePath)) {
        $backup=Join-Path $dir ('backup-'+[DateTime]::UtcNow.ToString('yyyyMMdd-HHmmss-fffffff')+'.json')
        [IO.File]::Replace($tmp,$script:StorePath,$backup)
    } else { [IO.File]::Move($tmp,$script:StorePath) }
}
function Load-Store {
    if (Test-Path -LiteralPath $script:StorePath) { return (Get-Content -Raw -Encoding UTF8 -LiteralPath $script:StorePath | ConvertFrom-Json) }
    return New-Store
}
function Parse-Timesheet([string]$path) {
    $b=Read-Book $path
    if (!$b.sheets.ContainsKey('Timesheet') -or !$b.sheets.ContainsKey('Expenses')) { throw 'Required Timesheet/Expenses sheets missing.' }
    $t=$b.sheets.Timesheet.cells; $e=$b.sheets.Expenses.cells; $s=$b.sheets.Service_Comp.cells
    $serial=Number $t.N5
    if ($null -eq $serial -or $serial -lt 1) { throw 'No valid week ending date.' }
    $date=[DateTime]::FromOADate($serial)
    if ($b.date1904) { $date=$date.AddDays(1462) }
    $week=$date.ToString('yyyy-MM-dd'); $employee=([string]$t.N4).Trim()
    if (!$employee) { throw 'Employee name is missing.' }
    $id=(Hash-Text ($employee.ToUpperInvariant()+'|'+$week)).Substring(0,20)
    $issues=[Collections.Generic.List[string]]::new()
    if ($date.DayOfWeek -ne 'Saturday') { $issues.Add('Week ending is not Saturday.') }
    if ($date.Date -gt [DateTime]::Today) { $issues.Add('Future week: may be a draft.') }
    $totalRow=Find-Row $t 'D' 'Totals\s*==>'
    $header=Find-Row $t 'A' '^Project Customer'
    $supportHeader=Find-Row $t 'A' '^Support Customer'
    if (!$totalRow -or !$header) { throw 'Could not identify time-entry section boundaries.' }
    $entries=@(); $claims=@(); $company=@(); $starts=@('D','F','H','J','L','N','P'); $durations=@('E','G','I','K','M','O','Q')
    for ($r=$header+1; $r -lt $totalRow; $r++) {
        # Real duration rows have a row total. This excludes repeated date/header rows.
        if (!$b.sheets.Timesheet.formulas.ContainsKey("R$r") -and $null -eq (Number $t["R$r"])) { continue }
        $desc=([string]$t["A$r"]).Trim(); $rawProject=[string]$t["B$r"]; $project=Project-Code $rawProject
        for ($d=0; $d -lt 7; $d++) {
            $cell=$durations[$d]+$r; $hours=Number $t[$cell]
            if ($null -eq $hours -or $hours -eq 0) { continue }
            if ($hours -lt 0 -or $hours -gt 24) { $issues.Add("Unusual duration at Timesheet!${cell}: $hours") }
            $entryId="$id|Timesheet|$cell"
            $entries += [pscustomobject]@{ id=$entryId; date=$date.AddDays($d-6).ToString('yyyy-MM-dd'); project=$project; rawProject=$rawProject; description=$desc; activity=[string]$t["C$r"]; hours=$hours; start=(Number $t[($starts[$d]+$r)]); service=($supportHeader -and $r -gt $supportHeader); source="Timesheet!$cell" }
        }
    }
    $reportedHours=Number $t["R$totalRow"]; $sumHours=[double]($entries | Measure-Object hours -Sum).Sum
    if ($null -eq $reportedHours -or [Math]::Abs($reportedHours-$sumHours) -gt 0.01) { $issues.Add('Daily hours do not match the saved weekly total (or the total is missing).') }
    $jobRow=Find-Row $e 'A' '^\s*Job Number'; $employeeRow=Find-Row $e 'A' '^\s*Expenses Paid by Employee'; $companyRow=Find-Row $e 'A' '^\s*Expenses Paid by Company'
    if (!$jobRow -or !$employeeRow -or !$companyRow) { throw 'Could not identify expense section boundaries.' }
    $expenseTotal=@($e.Keys | Where-Object { $_ -match '^A\d+$' -and [string]$e[$_] -match '^\s*Total\s*$' } | ForEach-Object { [int]($_ -replace '\D','') } | Where-Object { $_ -gt $employeeRow } | Sort-Object)[0]
    if (!$expenseTotal) { throw 'Employee expense total missing.' }
    $cols=@('B','C','D','E','F','G','H')
    foreach ($range in @(@{first=$companyRow+1;last=$employeeRow-1;company=$true},@{first=$employeeRow+1;last=$expenseTotal-1;company=$false})) {
        for ($r=$range.first; $r -le $range.last; $r++) {
            $label=([string]$e["A$r"]).Trim()
            if ($label -match '^Total$') { continue }
            for ($d=0; $d -lt 7; $d++) {
                $cell=$cols[$d]+$r; $amount=Number $e[$cell]
                if ($null -eq $amount -or $amount -eq 0) { continue }
                $category=if ($label -eq 'Per Diem') {'Per diem'} else {'Reimbursement'}
                $item=[pscustomobject]@{ id="$id|Expenses|$cell"; week=$week; date=$date.AddDays($d-6).ToString('yyyy-MM-dd'); project=(Project-Code $e[($cols[$d]+$jobRow)]); category=$category; description=$label; amount=[Math]::Round($amount,2); source="Expenses!$cell"; origin='Workbook'; unit='USD' }
                if ($range.company) { $company += $item } else { $claims += $item }
            }
        }
    }
    $expenseSaved=Number $e["I$expenseTotal"]; $expenseSum=($claims | Measure-Object amount -Sum).Sum
    if ($null -ne $expenseSaved -and [Math]::Abs($expenseSaved-$expenseSum) -gt 0.02) { $issues.Add('Expense line items do not match the saved employee expense total.') }
    $compTime=0
    if ($s) {
        $cash=Number $s.H53; $compTime=Number $s.J53
        if ($null -eq $cash) { $issues.Add('Service compensation total is missing; review workbook.') }
        if ($cash -ne 0 -and $null -ne $cash) {
            $claims += [pscustomobject]@{ id="$id|Service_Comp|H53"; week=$week; date=$week; project='UNASSIGNED'; category='Service compensation'; description='Saved service cash total (includes on-call if selected)'; amount=[Math]::Round($cash,2); source='Service_Comp!H53'; origin='Workbook'; unit='USD' }
        }
        $timeSum=0; for ($r=43;$r -le 52;$r++) { $timeSum += [double](Number $s["J$r"]) }
        if ([Math]::Abs($timeSum-$compTime) -gt 0.01) { $issues.Add('Saved comp-time total excludes or differs from line items.') }
    } else { $issues.Add('Service_Comp sheet missing.') }
    foreach ($name in @('Timesheet','Expenses','Service_Comp')) {
        if ($b.sheets[$name].errors.Count) { $issues.Add("Excel errors in ${name}: " + ($b.sheets[$name].errors -join ', ')) }
    }
    if (!$entries.Count -and !$claims.Count -and !$company.Count) { $issues.Add('Empty dated workbook: no work or expenses.') }
    if (@($claims | Where-Object project -eq 'UNASSIGNED').Count) { $issues.Add('Some claims have no clear project; assign them in Claims.') }
    return [pscustomobject]@{ id=$id; hash=$b.hash; file=$path; week=$week; employee=$employee; hours=$sumHours; reportedHours=$reportedHours; expenseReported=$expenseSaved; compTime=$compTime; entries=@($entries); claims=@($claims); companyExpenses=@($company); issues=@($issues); active=$true }
}
function Import-Timesheets($db) {
    if (!(Test-Path -LiteralPath $db.source -PathType Container)) { throw 'Timesheet directory does not exist.' }
    $log=@(); $seen=@{}
    foreach ($file in Get-ChildItem -LiteralPath $db.source -Recurse -File | Where-Object { $_.Extension -in @('.xlsm','.xlsx') } | Sort-Object FullName) {
        if ($file.Name -match 'BLANK|^~\$') { $log += @{file=$file.FullName; status='Skipped'; message='Template or Excel temporary file'}; continue }
        try {
            $w=Parse-Timesheet $file.FullName
            if ($seen.ContainsKey($w.hash)) { $log += @{file=$file.FullName;status='Duplicate';message='Identical to '+$seen[$w.hash]}; continue }
            $seen[$w.hash]=$file.FullName
            $prior=@($db.weeks | Where-Object hash -eq $w.hash)
            if (!$prior.Count) { $db.weeks=@($db.weeks)+@($w) }
            $log += @{file=$file.FullName;status='Imported';message=$w.week}
        } catch { $log += @{file=$file.FullName;status='Error';message=$_.Exception.Message} }
    }
    foreach ($group in $db.weeks | Group-Object id) {
        $select=@($db.selections | Where-Object id -eq $group.Name | Select-Object -Last 1)
        foreach ($w in $group.Group) { $w.active=if ($select.Count) { $w.hash -eq $select[0].hash } else { $group.Count -eq 1 } }
    }
    $known=@{}; foreach ($p in $db.projects) { $known[$p.code]=$true }
    $descriptions=@{}
    foreach ($w in $db.weeks) { foreach ($entry in $w.entries) { if ($entry.project -ne 'UNASSIGNED' -and $entry.description) { $descriptions[$entry.project]=$entry.description } } }
    foreach ($w in $db.weeks) {
        foreach ($item in @($w.entries)+@($w.claims)+@($w.companyExpenses)) {
            if ($item.project -ne 'UNASSIGNED' -and !$known.ContainsKey($item.project)) {
                $description=if ($descriptions.ContainsKey($item.project)) { $descriptions[$item.project] } else { 'Project '+$item.project }
                $db.projects=@($db.projects)+@([pscustomobject]@{code=$item.project;description=$description;rules=@();notes=''})
                $known[$item.project]=$true
            }
        }
    }
    $db.importLog=@($log); $db.importedAt=[DateTime]::UtcNow.ToString('o')
}
function Valid-Date($s) {
    $d=[DateTime]::MinValue
    if (![DateTime]::TryParseExact([string]$s,'yyyy-MM-dd',$script:Invariant,[Globalization.DateTimeStyles]::None,[ref]$d)) { throw 'Enter a date in YYYY-MM-DD format.' }
    return [string]$s
}
function Apply-Change($db,[string]$action,$body) {
    switch ($action) {
        'upload' {
            if ([string]$body.name -notmatch '^[A-Za-z0-9_ .()-]+\.(xlsm|xlsx)$' -or [string]$body.name -match 'BLANK') { throw 'Choose a named .xlsm or .xlsx timesheet (not a blank template).' }
            $bytes=[Convert]::FromBase64String([string]$body.content)
            if ($bytes.Length -gt 12582912) { throw 'Maximum workbook size is 12 MB.' }
            $uploadDir=Join-Path (Split-Path $script:StorePath) 'uploads'
            [IO.Directory]::CreateDirectory($uploadDir) | Out-Null
            $path=Join-Path $uploadDir ([guid]::NewGuid().ToString()+'-'+$body.name)
            [IO.File]::WriteAllBytes($path,$bytes)
            try { $w=Parse-Timesheet $path } catch { [IO.File]::Delete($path); throw }
            if (!@($db.weeks | Where-Object hash -eq $w.hash).Count) { $db.weeks=@($db.weeks)+@($w) }
            # Use the normal reconciliation logic without scanning arbitrary client paths.
            $originalSource=$db.source
            try { $db.source=$uploadDir; Import-Timesheets $db } finally { $db.source=$originalSource }
        }
        'project' {
            $code=Project-Code $body.code
            if ($code -eq 'UNASSIGNED') { throw 'Use a full project code, for example P8305-43.' }
            $p=@($db.projects | Where-Object code -eq $code)
            if (!$p.Count) { $db.projects=@($db.projects)+@([pscustomobject]@{code=$code;description='';notes='';rules=@()}); $p=@($db.projects | Where-Object code -eq $code) }
            $p[0].description=([string]$body.description).Trim(); $p[0].notes=[string]$body.notes
            if ($body.rule) {
                $date=Valid-Date $body.rule.effective
                if ($body.rule.mode -notin @('manual','daily8','weekly40','all')) { throw 'Unsupported compensation rule.' }
                $rule=[pscustomobject]@{id=[guid]::NewGuid().ToString();effective=$date;mode=$body.rule.mode;perDiem=$null;travel=$null;onsite=$null;billableOnsite=$null;billableTravel=$null;notes=[string]$body.rule.notes}
                foreach ($field in @('perDiem','travel','onsite','billableOnsite','billableTravel')) {
                    if ([string]$body.rule.$field -ne '') { $n=Number $body.rule.$field; if ($null -eq $n -or $n -lt 0 -or $n -gt 100000) { throw 'Rates must be non-negative numbers.' }; $rule.$field=$n }
                }
                $p[0].rules=@($p[0].rules)+@($rule)
            }
        }
        'assign' {
            $code=Project-Code $body.project
            if ($code -ne 'UNASSIGNED' -and !@($db.projects | Where-Object code -eq $code).Count) { throw 'Create the project first.' }
            $all=@($db.weeks | ForEach-Object { @($_.entries)+@($_.claims)+@($_.companyExpenses) })+@($db.manualClaims)
            if (!@($all | Where-Object id -eq $body.id).Count) { throw 'Record not found.' }
            $db.assignments=@($db.assignments | Where-Object id -ne $body.id)+@([pscustomobject]@{id=[string]$body.id;project=$code})
        }
        'select' {
            if (!@($db.weeks | Where-Object { $_.id -eq $body.id -and (!$body.hash -or $_.hash -eq $body.hash) }).Count) { throw 'Workbook version not found.' }
            $db.selections=@($db.selections | Where-Object id -ne $body.id)+@([pscustomobject]@{id=$body.id;hash=$body.hash})
            foreach ($w in $db.weeks | Where-Object id -eq $body.id) { $w.active=($w.hash -eq $body.hash) }
        }
        'claim' {
            $date=Valid-Date $body.date; $amount=Number $body.amount
            if ($null -eq $amount -or [Math]::Round($amount,2) -le 0 -or $amount -gt 10000000) { throw 'Claim amount must be positive.' }
            if ($body.category -notin @('Project compensation','Service compensation','Per diem','Reimbursement')) { throw 'Invalid claim category.' }
            $project=Project-Code $body.project
            if ($project -eq 'UNASSIGNED' -or !@($db.projects | Where-Object code -eq $project).Count) { throw 'Select an existing project.' }
            if (![string]$body.description) { throw 'Describe the claim and its basis.' }
            $d=[DateTime]::ParseExact($date,'yyyy-MM-dd',$script:Invariant)
            $db.manualClaims=@($db.manualClaims)+@([pscustomobject]@{id=[guid]::NewGuid().ToString();date=$date;week=$d.AddDays(6-[int]$d.DayOfWeek).ToString('yyyy-MM-dd');project=$project;category=$body.category;description=[string]$body.description;amount=[Math]::Round($amount,2);source='Manual entry';origin='Manual';unit='USD';void=$false})
        }
        'voidClaim' {
            $c=@($db.manualClaims | Where-Object id -eq $body.id)
            if (!$c.Count) { throw 'Only manual claims can be voided.' }; $c[0].void=$true
        }
        'payment' {
            $date=Valid-Date $body.date; $amount=Number $body.amount
            if ($null -eq $amount -or [Math]::Round($amount,2) -le 0 -or $amount -gt 10000000) { throw 'Payment amount must be positive.' }
            $alloc=@(); $sum=0; $ids=@{}
            $claims=@($db.weeks | Where-Object active | ForEach-Object claims)+@($db.manualClaims | Where-Object { !$_.void })
            foreach ($a in $body.allocations) {
                $n=Number $a.amount
                if ($null -eq $n -or [Math]::Round($n,2) -le 0 -or !@($claims | Where-Object id -eq $a.claimId).Count) { throw 'Invalid payment allocation.' }
                if ($ids.ContainsKey([string]$a.claimId)) { throw 'Duplicate allocation.' }; $ids[[string]$a.claimId]=$true
                $claim=@($claims | Where-Object id -eq $a.claimId)[0]
                $n=[Math]::Round($n,2); $sum+=$n; $alloc+=@([pscustomobject]@{claimId=[string]$a.claimId;amount=$n;sourceAmount=$claim.amount;sourceCategory=$claim.category;sourceDate=$claim.date})
            }
            if ([Math]::Round($sum,2) -gt [Math]::Round($amount,2)) { throw 'Allocated amounts exceed the payment.' }
            $db.payments=@($db.payments)+@([pscustomobject]@{id=[guid]::NewGuid().ToString();date=$date;amount=[Math]::Round($amount,2);reference=[string]$body.reference;notes=[string]$body.notes;allocations=@($alloc);void=$false;createdAt=[DateTime]::UtcNow.ToString('o')})
        }
        'voidPayment' {
            $p=@($db.payments | Where-Object id -eq $body.id)
            if (!$p.Count) { throw 'Payment not found.' }; $p[0].void=$true
        }
        'import' { Import-Timesheets $db }
        default { throw 'Unknown action.' }
    }
    $db.audit=@($db.audit)+@([pscustomobject]@{at=[DateTime]::UtcNow.ToString('o');action=$action;record=[string]$body.id})
}

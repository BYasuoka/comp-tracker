param([Parameter(Mandatory=$true)][string]$Path)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.IO.Compression.FileSystem
$zip = [IO.Compression.ZipFile]::OpenRead($Path)
function Read-Xml([string]$Name) {
    $entry = $zip.GetEntry($Name)
    if (!$entry) { return $null }
    $reader = [IO.StreamReader]::new($entry.Open())
    try { [xml]$reader.ReadToEnd() } finally { $reader.Dispose() }
}
try {
    $strings = @( (Read-Xml 'xl/sharedStrings.xml').sst.si | ForEach-Object { $_.InnerText })
    $book = Read-Xml 'xl/workbook.xml'
    $rels = Read-Xml 'xl/_rels/workbook.xml.rels'
    "WORKBOOK: $Path"
    "MACROS PRESENT: $($null -ne $zip.GetEntry('xl/vbaProject.bin')) (not executed)"
    foreach ($sheet in $book.workbook.sheets.sheet) {
        $id = $sheet.GetAttribute('id', 'http://schemas.openxmlformats.org/officeDocument/2006/relationships')
        $target = ($rels.Relationships.Relationship | Where-Object Id -eq $id).Target
        $part = if ($target.StartsWith('/')) { $target.TrimStart('/') } else { 'xl/' + $target }
        $xml = Read-Xml $part
        "`nSHEET: $($sheet.name) [$($xml.worksheet.dimension.ref)]"
        foreach ($row in $xml.worksheet.sheetData.row) {
            $cells = foreach ($cell in $row.c) {
                $value = [string]$cell.v
                if ($cell.t -eq 's') { $value = $strings[[int]$value] }
                if ($cell.t -eq 'inlineStr') { $value = $cell.is.InnerText }
                $formula = $cell.SelectSingleNode('*[local-name()="f"]')
                if ($value -ne '' -or $formula) {
                    $suffix = if ($formula) { ' FORMULA=' + $formula.InnerText + ' ' + $formula.OuterXml } else { '' }
                    "$($cell.r)=$value$suffix"
                }
            }
            if ($cells) { $cells -join ' | ' }
        }
        'MERGES: ' + (($xml.worksheet.mergeCells.mergeCell | ForEach-Object ref) -join ', ')
    }
    "`nDEFINED NAMES"
    foreach ($name in $book.workbook.definedNames.definedName) { "$($name.name)=$($name.InnerText)" }
} finally { $zip.Dispose() }

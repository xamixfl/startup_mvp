$ErrorActionPreference = "Stop"

function Test-ValidUtf8Bytes {
  param([byte[]]$Bytes)
  try {
    $utf8Strict = New-Object System.Text.UTF8Encoding($false, $true)
    [void]$utf8Strict.GetString($Bytes)
    return $true
  } catch {
    return $false
  }
}

function Unmangle-Utf8AsCp1251 {
  param([string]$Text)
  # If UTF-8 bytes were mistakenly decoded as Windows-1251 and saved, text looks like: "РЎРѕР·РґР°С‚СЊ ..."
  # Reverse it by re-encoding this wrong text as 1251 bytes and decoding as UTF-8.
  $cp1251 = [System.Text.Encoding]::GetEncoding(1251)
  $utf8 = New-Object System.Text.UTF8Encoding($false, $true)
  $bytes = $cp1251.GetBytes($Text)
  return $utf8.GetString($bytes)
}

function Looks-LikeMojibake {
  param([string]$Text)

  if ([string]::IsNullOrEmpty($Text)) { return $false }

  # Common patterns when Russian UTF-8 is shown as cp1251: lots of "Р" and "С", and "вЂ" instead of "—".
  $rCount = ([regex]::Matches($Text, "Р")).Count
  $sCount = ([regex]::Matches($Text, "С")).Count
  $dashMojibake = $Text.Contains("вЂ")

  # Heuristic: needs to be quite frequent to avoid damaging already-correct Russian text.
  return ($dashMojibake -or (($rCount + $sCount) -ge 25 -and $rCount -ge 8 -and $sCount -ge 8))
}

function Fix-FileEncoding {
  param([string]$Path)

  $bytes = [System.IO.File]::ReadAllBytes($Path)
  $isUtf8 = Test-ValidUtf8Bytes -Bytes $bytes

  $text = $null
  $changed = $false

  if (-not $isUtf8) {
    # Treat as Windows-1251 and convert to UTF-8.
    $cp1251 = [System.Text.Encoding]::GetEncoding(1251)
    $text = $cp1251.GetString($bytes)
    $changed = $true
  } else {
    $utf8 = New-Object System.Text.UTF8Encoding($false, $true)
    $text = $utf8.GetString($bytes)
    if (Looks-LikeMojibake -Text $text) {
      $fixed = Unmangle-Utf8AsCp1251 -Text $text
      if ($fixed -ne $text) {
        $text = $fixed
        $changed = $true
      }
    }
  }

  if ($changed) {
    # Write UTF-8 without BOM.
    $utf8NoBom = New-Object System.Text.UTF8Encoding($false)
    [System.IO.File]::WriteAllText($Path, $text, $utf8NoBom)
    return $true
  }

  return $false
}

$root = Resolve-Path "."

$targets = @()
$targets += Get-ChildItem -Path $root -File -Filter *.html | Where-Object { $_.Name -ne "auth.html" }
$targets += Get-ChildItem -Path (Join-Path $root "js") -File -Filter *.js

$fixed = @()
foreach ($f in $targets) {
  if (Fix-FileEncoding -Path $f.FullName) {
    $fixed += $f.FullName
  }
}

Write-Host ("Fixed: {0} file(s)" -f $fixed.Count)
if ($fixed.Count -gt 0) {
  $fixed | ForEach-Object { Write-Host ("- " + $_) }
}


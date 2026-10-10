# Builds wealth-ledger.ico, compiles launcher\WealthLedger.cs into WealthLedger.exe,
# and puts a "Wealth Ledger" shortcut on the Desktop that runs it. Re-run this any
# time the shortcut is moved or deleted, or after the launcher source changes.
param(
  [string]$IconPath,
  [string]$ExePath,
  [string]$ShortcutPath
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
if (-not $IconPath) { $IconPath = Join-Path $root 'wealth-ledger.ico' }
if (-not $ExePath) { $ExePath = Join-Path $root 'WealthLedger.exe' }
if (-not $ShortcutPath) { $ShortcutPath = Join-Path ([Environment]::GetFolderPath('Desktop')) 'Wealth Ledger.lnk' }

Add-Type -AssemblyName System.Drawing

# The app's own favicon is a rupee on a green tile, so the shortcut matches it.
function New-IconTile {
  param([int]$Size)

  $bmp = [System.Drawing.Bitmap]::new($Size, $Size, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
  $g.TextRenderingHint = [System.Drawing.Text.TextRenderingHint]::AntiAliasGridFit
  $g.Clear([System.Drawing.Color]::Transparent)

  $d = [Math]::Max(4, [int]($Size * 0.36))
  $path = [System.Drawing.Drawing2D.GraphicsPath]::new()
  $path.AddArc(0, 0, $d, $d, 180, 90)
  $path.AddArc($Size - $d, 0, $d, $d, 270, 90)
  $path.AddArc($Size - $d, $Size - $d, $d, $d, 0, 90)
  $path.AddArc(0, $Size - $d, $d, $d, 90, 90)
  $path.CloseFigure()

  $brush = [System.Drawing.Drawing2D.LinearGradientBrush]::new(
    ([System.Drawing.Rectangle]::new(0, 0, $Size, $Size)),
    ([System.Drawing.Color]::FromArgb(255, 34, 197, 94)),
    ([System.Drawing.Color]::FromArgb(255, 21, 128, 61)),
    ([System.Drawing.Drawing2D.LinearGradientMode]::ForwardDiagonal))
  $g.FillPath($brush, $path)

  $style = [System.Drawing.FontStyle]::Bold -bor [System.Drawing.FontStyle]::Italic
  $font = [System.Drawing.Font]::new('Segoe UI', [float]($Size * 0.60), $style, [System.Drawing.GraphicsUnit]::Pixel)
  $format = [System.Drawing.StringFormat]::new()
  $format.Alignment = [System.Drawing.StringAlignment]::Center
  $format.LineAlignment = [System.Drawing.StringAlignment]::Center
  $box = [System.Drawing.RectangleF]::new(0, [float]($Size * -0.03), $Size, $Size)
  $g.DrawString([string][char]0x20B9, $font, [System.Drawing.Brushes]::White, $box, $format)
  $g.Dispose()
  return $bmp
}

function Get-PngFrame {
  param([int]$Size)
  $bmp = New-IconTile -Size $Size
  $ms = [System.IO.MemoryStream]::new()
  $bmp.Save($ms, [System.Drawing.Imaging.ImageFormat]::Png)
  $bytes = $ms.ToArray()
  $ms.Dispose()
  $bmp.Dispose()
  return [byte[]]$bytes
}

# Uncompressed 32bpp DIB frame: header, BGRA pixels bottom-up, then a zeroed AND mask.
# Explorer happily reads PNG frames, but GDI+ and ExtractIcon only understand this.
function Get-DibFrame {
  param([int]$Size)
  $bmp = New-IconTile -Size $Size
  $rect = [System.Drawing.Rectangle]::new(0, 0, $Size, $Size)
  $data = $bmp.LockBits($rect, [System.Drawing.Imaging.ImageLockMode]::ReadOnly, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
  $pixels = [byte[]]::new($data.Stride * $Size)
  [System.Runtime.InteropServices.Marshal]::Copy($data.Scan0, $pixels, 0, $pixels.Length)
  $bmp.UnlockBits($data)
  $bmp.Dispose()

  $maskStride = [int]([Math]::Ceiling($Size / 32) * 4)
  $out = [System.IO.MemoryStream]::new()
  $w = [System.IO.BinaryWriter]::new($out)
  $w.Write([int32]40)
  $w.Write([int32]$Size)
  $w.Write([int32]($Size * 2))
  $w.Write([int16]1)
  $w.Write([int16]32)
  $w.Write([int32]0)
  $w.Write([int32]($pixels.Length + $maskStride * $Size))
  $w.Write([int32]0); $w.Write([int32]0); $w.Write([int32]0); $w.Write([int32]0)
  $w.Write($pixels)
  $w.Write([byte[]]::new($maskStride * $Size))
  $w.Flush()
  $bytes = $out.ToArray()
  $w.Dispose()
  return [byte[]]$bytes
}

$images = [System.Collections.ArrayList]::new()
foreach ($size in 256, 48, 32, 16) {
  $frame = if ($size -ge 256) { Get-PngFrame -Size $size } else { Get-DibFrame -Size $size }
  [void]$images.Add([pscustomobject]@{ Size = $size; Bytes = [byte[]]$frame })
}

$icon = [System.IO.MemoryStream]::new()
$w = [System.IO.BinaryWriter]::new($icon)
$w.Write([uint16]0)
$w.Write([uint16]1)
$w.Write([uint16]$images.Count)
$offset = 6 + (16 * $images.Count)
foreach ($image in $images) {
  $edge = if ($image.Size -ge 256) { 0 } else { $image.Size }
  $w.Write([byte]$edge)
  $w.Write([byte]$edge)
  $w.Write([byte]0)
  $w.Write([byte]0)
  $w.Write([uint16]1)
  $w.Write([uint16]32)
  $w.Write([uint32]$image.Bytes.Length)
  $w.Write([uint32]$offset)
  $offset += $image.Bytes.Length
}
foreach ($image in $images) { $w.Write([byte[]]$image.Bytes) }
$w.Flush()
[System.IO.File]::WriteAllBytes($IconPath, $icon.ToArray())
$w.Dispose()

# --- Compile the launcher ---------------------------------------------------
# csc.exe ships with the .NET Framework that Windows already has, so this needs no
# SDK, no MSBuild and no network. /target:winexe keeps a console window from
# flashing on double-click; the launcher reads PORT from the environment, so a
# non-default port is a `set PORT=…` away rather than a rebuild.
$csc = Join-Path $env:SystemRoot 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'
if (-not (Test-Path $csc)) { $csc = Join-Path $env:SystemRoot 'Microsoft.NET\Framework\v4.0.30319\csc.exe' }
if (-not (Test-Path $csc)) { throw "csc.exe was not found under $env:SystemRoot\Microsoft.NET." }

& $csc -nologo -target:winexe "-win32icon:$IconPath" "-out:$ExePath" `
  '-r:System.Windows.Forms.dll' (Join-Path $root 'launcher\WealthLedger.cs')
if ($LASTEXITCODE -ne 0) { throw "csc.exe exited with $LASTEXITCODE - WealthLedger.exe was not rebuilt." }

$shell = New-Object -ComObject WScript.Shell
$lnk = $shell.CreateShortcut($ShortcutPath)
$lnk.TargetPath = $ExePath
$lnk.Arguments = ''
$lnk.WorkingDirectory = $root
$lnk.IconLocation = "$ExePath,0"
$lnk.Description = 'Start the Wealth Ledger server and open it in a new Chrome tab'
$lnk.WindowStyle = 1
$lnk.Save()

Write-Host "Icon      $IconPath"
Write-Host "Launcher  $ExePath"
Write-Host "Shortcut  $ShortcutPath"

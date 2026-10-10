# Draws the launcher icons the phone install needs, from the same rupee-on-green
# tile the desktop shortcut uses. Run it again after changing the art:
#   powershell -ExecutionPolicy Bypass -File .\make-phone-icons.ps1
#
# A PWA launcher icon has to be a real PNG - an SVG is ignored on some Android
# launchers and iOS will not use one for the home-screen tile at all - and this
# project has no build step, so the tiles are drawn here with .NET's own GDI+
# instead of adding an image package.
param([string]$Root = (Split-Path -Parent $MyInvocation.MyCommand.Path))

$Out = Join-Path $Root 'public\icons'
Add-Type -AssemblyName System.Drawing

$Green1 = [System.Drawing.Color]::FromArgb(255, 34, 197, 94)
$Green2 = [System.Drawing.Color]::FromArgb(255, 21, 128, 61)
$Rupee = [string][char]0x20B9

function New-Tile {
  param([int]$Size, [switch]$FullBleed, [double]$Glyph = 0.60)

  $bmp = [System.Drawing.Bitmap]::new($Size, $Size, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
  $g.TextRenderingHint = [System.Drawing.Text.TextRenderingHint]::AntiAliasGridFit
  $g.Clear([System.Drawing.Color]::Transparent)

  $rect = [System.Drawing.Rectangle]::new(0, 0, $Size, $Size)
  $brush = [System.Drawing.Drawing2D.LinearGradientBrush]::new($rect, $Green1, $Green2,
    [System.Drawing.Drawing2D.LinearGradientMode]::ForwardDiagonal)

  if ($FullBleed) {
    # Maskable icons and the iOS tile are cropped by the launcher, so every pixel
    # has to be painted and the glyph kept inside the central safe zone.
    $g.FillRectangle($brush, $rect)
  } else {
    $d = [Math]::Max(4, [int]($Size * 0.22))
    $path = [System.Drawing.Drawing2D.GraphicsPath]::new()
    [void]$path.AddArc(0, 0, $d, $d, 180, 90)
    [void]$path.AddArc($Size - $d, 0, $d, $d, 270, 90)
    [void]$path.AddArc($Size - $d, $Size - $d, $d, $d, 0, 90)
    [void]$path.AddArc(0, $Size - $d, $d, $d, 90, 90)
    [void]$path.CloseFigure()
    $g.FillPath($brush, $path)
  }

  $style = [System.Drawing.FontStyle]::Bold -bor [System.Drawing.FontStyle]::Italic
  $font = [System.Drawing.Font]::new('Segoe UI', [float]($Size * $Glyph), $style, [System.Drawing.GraphicsUnit]::Pixel)
  $format = [System.Drawing.StringFormat]::new()
  $format.Alignment = [System.Drawing.StringAlignment]::Center
  $format.LineAlignment = [System.Drawing.StringAlignment]::Center
  $box = [System.Drawing.RectangleF]::new(0, [float]($Size * -0.03), $Size, $Size)
  $g.DrawString($Rupee, $font, [System.Drawing.Brushes]::White, $box, $format)
  $g.Dispose()
  return $bmp
}

function Save-Png {
  param([System.Drawing.Bitmap]$Bmp, [string]$Name)
  $ms = [System.IO.MemoryStream]::new()
  $Bmp.Save($ms, [System.Drawing.Imaging.ImageFormat]::Png)
  [System.IO.File]::WriteAllBytes((Join-Path $Out $Name), $ms.ToArray())
  $ms.Dispose()
  $Bmp.Dispose()
  "  $Name"
}

if (-not (Test-Path $Out)) { [void](New-Item -ItemType Directory -Path $Out) }
"Phone icons -> $Out"

# Manifest sizes Android looks for, the maskable variant the launcher crops, and
# the two Apple tiles: 180 for the home screen and 152 for the iPad one.
Save-Png (New-Tile -Size 192) 'icon-192.png'
Save-Png (New-Tile -Size 512) 'icon-512.png'
Save-Png (New-Tile -Size 512 -FullBleed -Glyph 0.44) 'maskable-512.png'
Save-Png (New-Tile -Size 180 -FullBleed -Glyph 0.50) 'apple-touch-icon.png'
Save-Png (New-Tile -Size 152 -FullBleed -Glyph 0.50) 'apple-touch-icon-152.png'

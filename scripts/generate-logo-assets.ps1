param(
  [string]$SourcePath = "assets/Logo1000x1000.png",
  [string]$OutputPath = "assets/icons"
)

$ErrorActionPreference = "Stop"

Add-Type -AssemblyName System.Drawing

$repoRoot = Resolve-Path (Join-Path $PSScriptRoot "..")
$sourceFile = if ([System.IO.Path]::IsPathRooted($SourcePath)) {
  $SourcePath
} else {
  Join-Path $repoRoot $SourcePath
}
$outputDir = if ([System.IO.Path]::IsPathRooted($OutputPath)) {
  $OutputPath
} else {
  Join-Path $repoRoot $OutputPath
}

if (-not (Test-Path -LiteralPath $sourceFile)) {
  throw "Logo source was not found: $sourceFile"
}

New-Item -ItemType Directory -Force -Path $outputDir | Out-Null

function Save-LogoPng {
  param(
    [System.Drawing.Image]$Source,
    [int]$Size,
    [string]$TargetPath
  )

  $bitmap = New-Object System.Drawing.Bitmap $Size, $Size, ([System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
  $bitmap.SetResolution(96, 96)
  $graphics = [System.Drawing.Graphics]::FromImage($bitmap)

  try {
    $graphics.Clear([System.Drawing.Color]::Transparent)
    $graphics.CompositingMode = [System.Drawing.Drawing2D.CompositingMode]::SourceOver
    $graphics.CompositingQuality = [System.Drawing.Drawing2D.CompositingQuality]::HighQuality
    $graphics.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
    $graphics.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
    $graphics.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::HighQuality
    $graphics.DrawImage($Source, 0, 0, $Size, $Size)
    $bitmap.Save($TargetPath, [System.Drawing.Imaging.ImageFormat]::Png)
  } finally {
    $graphics.Dispose()
    $bitmap.Dispose()
  }
}

function Write-UInt16LittleEndian {
  param([System.IO.BinaryWriter]$Writer, [int]$Value)
  $Writer.Write([byte]($Value -band 0xff))
  $Writer.Write([byte](($Value -shr 8) -band 0xff))
}

function Write-UInt32LittleEndian {
  param([System.IO.BinaryWriter]$Writer, [int]$Value)
  $Writer.Write([byte]($Value -band 0xff))
  $Writer.Write([byte](($Value -shr 8) -band 0xff))
  $Writer.Write([byte](($Value -shr 16) -band 0xff))
  $Writer.Write([byte](($Value -shr 24) -band 0xff))
}

function Write-UInt32BigEndian {
  param([System.IO.BinaryWriter]$Writer, [int]$Value)
  $Writer.Write([byte](($Value -shr 24) -band 0xff))
  $Writer.Write([byte](($Value -shr 16) -band 0xff))
  $Writer.Write([byte](($Value -shr 8) -band 0xff))
  $Writer.Write([byte]($Value -band 0xff))
}

function Write-Ico {
  param(
    [string]$TargetPath,
    [int[]]$Sizes,
    [hashtable]$PngFiles
  )

  $pngData = @()
  foreach ($size in $Sizes) {
    $pngData += [pscustomobject]@{
      Size = $size
      Data = [System.IO.File]::ReadAllBytes($PngFiles[$size])
    }
  }

  $stream = [System.IO.File]::Open($TargetPath, [System.IO.FileMode]::Create, [System.IO.FileAccess]::Write)
  $writer = New-Object System.IO.BinaryWriter $stream

  try {
    Write-UInt16LittleEndian $writer 0
    Write-UInt16LittleEndian $writer 1
    Write-UInt16LittleEndian $writer $pngData.Count

    $offset = 6 + (16 * $pngData.Count)
    foreach ($entry in $pngData) {
      $encodedSize = if ($entry.Size -eq 256) { 0 } else { $entry.Size }
      $writer.Write([byte]$encodedSize)
      $writer.Write([byte]$encodedSize)
      $writer.Write([byte]0)
      $writer.Write([byte]0)
      Write-UInt16LittleEndian $writer 1
      Write-UInt16LittleEndian $writer 32
      Write-UInt32LittleEndian $writer $entry.Data.Length
      Write-UInt32LittleEndian $writer $offset
      $offset += $entry.Data.Length
    }

    foreach ($entry in $pngData) {
      $writer.Write($entry.Data)
    }
  } finally {
    $writer.Dispose()
    $stream.Dispose()
  }
}

function Write-Icns {
  param(
    [string]$TargetPath,
    [object[]]$Entries,
    [hashtable]$PngFiles
  )

  $chunks = @()
  foreach ($entry in $Entries) {
    $chunks += [pscustomobject]@{
      Type = $entry.Type
      Data = [System.IO.File]::ReadAllBytes($PngFiles[$entry.Size])
    }
  }

  $totalLength = 8
  foreach ($chunk in $chunks) {
    $totalLength += 8 + $chunk.Data.Length
  }

  $stream = [System.IO.File]::Open($TargetPath, [System.IO.FileMode]::Create, [System.IO.FileAccess]::Write)
  $writer = New-Object System.IO.BinaryWriter $stream

  try {
    $writer.Write([System.Text.Encoding]::ASCII.GetBytes("icns"))
    Write-UInt32BigEndian $writer $totalLength

    foreach ($chunk in $chunks) {
      $writer.Write([System.Text.Encoding]::ASCII.GetBytes($chunk.Type))
      Write-UInt32BigEndian $writer (8 + $chunk.Data.Length)
      $writer.Write($chunk.Data)
    }
  } finally {
    $writer.Dispose()
    $stream.Dispose()
  }
}

$sourceImage = [System.Drawing.Image]::FromFile((Resolve-Path $sourceFile))

try {
  if ($sourceImage.Width -ne $sourceImage.Height) {
    throw "Logo source must be square. Found $($sourceImage.Width)x$($sourceImage.Height)."
  }

  $pngSizes = @(16, 24, 32, 48, 64, 128, 180, 192, 256, 512, 1024)
  $pngFiles = @{}

  foreach ($size in $pngSizes) {
    $target = Join-Path $outputDir "logo-$size.png"
    Save-LogoPng -Source $sourceImage -Size $size -TargetPath $target
    $pngFiles[$size] = $target
  }

  Copy-Item -LiteralPath $pngFiles[180] -Destination (Join-Path $outputDir "apple-touch-icon.png") -Force
  Copy-Item -LiteralPath $pngFiles[192] -Destination (Join-Path $outputDir "android-chrome-192x192.png") -Force
  Copy-Item -LiteralPath $pngFiles[512] -Destination (Join-Path $outputDir "android-chrome-512x512.png") -Force
  Copy-Item -LiteralPath $pngFiles[16] -Destination (Join-Path $outputDir "favicon-16x16.png") -Force
  Copy-Item -LiteralPath $pngFiles[32] -Destination (Join-Path $outputDir "favicon-32x32.png") -Force

  Write-Ico -TargetPath (Join-Path $outputDir "app.ico") -Sizes @(16, 24, 32, 48, 64, 128, 256) -PngFiles $pngFiles
  Write-Ico -TargetPath (Join-Path $outputDir "favicon.ico") -Sizes @(16, 32, 48) -PngFiles $pngFiles

  $icnsEntries = @(
    @{ Type = "icp4"; Size = 16 },
    @{ Type = "icp5"; Size = 32 },
    @{ Type = "icp6"; Size = 64 },
    @{ Type = "ic07"; Size = 128 },
    @{ Type = "ic08"; Size = 256 },
    @{ Type = "ic09"; Size = 512 },
    @{ Type = "ic10"; Size = 1024 },
    @{ Type = "ic11"; Size = 32 },
    @{ Type = "ic12"; Size = 64 },
    @{ Type = "ic13"; Size = 256 },
    @{ Type = "ic14"; Size = 512 }
  )
  Write-Icns -TargetPath (Join-Path $outputDir "app.icns") -Entries $icnsEntries -PngFiles $pngFiles

  Get-ChildItem -LiteralPath $outputDir | Sort-Object Name | Select-Object Name, Length
} finally {
  $sourceImage.Dispose()
}

param([string]$ExecutablePath)
$ErrorActionPreference = 'Stop'
$petProjectRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$petExecutable = Join-Path $petProjectRoot 'release\win-unpacked\Morrow.exe'
if ($ExecutablePath) { $petExecutable = [System.IO.Path]::GetFullPath($ExecutablePath) }
if (-not (Test-Path -LiteralPath $petExecutable -PathType Leaf)) {
    throw '尚未生成运行构建。请在仓库根目录执行 npm ci 和 npm run pack。'
}
$petOldDataDir = [Environment]::GetEnvironmentVariable('PET_DATA_DIR', 'Process')
try {
    $env:PET_DATA_DIR = Join-Path $petProjectRoot 'data\local'
    Start-Process -FilePath $petExecutable -WorkingDirectory $petProjectRoot -WindowStyle Hidden
} finally {
    [Environment]::SetEnvironmentVariable('PET_DATA_DIR', $petOldDataDir, 'Process')
}

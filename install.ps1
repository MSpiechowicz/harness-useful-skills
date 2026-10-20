# Harness Skills installer for OpenCode on Windows.
#
#   irm https://raw.githubusercontent.com/MSpiechowicz/harness-useful-skills/main/install.ps1 | iex
#
# Downloads the source tarball of a release from GitHub, checks it, and runs that release's own installer:
# `useful-skills install --host opencode --scope user`. The skills, agents, plugin and memory server land in your
# OpenCode user config. Needs Node.js 22 or newer and the Windows tar.exe (System32, Windows 10 and newer). Nothing is
# installed when any check fails, and the temporary download is always removed. Restart OpenCode afterwards. Re-run this
# installer to update.
#
# Failures are reported by throwing, so a piped run ends with an error and a non-zero exit code under
# `powershell -Command` without closing an interactive terminal.
#
# Environment overrides:
#   HARNESS_SKILLS_VERSION  release tag to install (default: latest), e.g. v0.3.7
#
# To pin a release:
#   $env:HARNESS_SKILLS_VERSION = 'v0.3.7'; irm https://raw.githubusercontent.com/MSpiechowicz/harness-useful-skills/main/install.ps1 | iex
#
# Redirects: Invoke-WebRequest keeps its default redirect limit here. GitHub answers both URLs directly today, and a limit
# or an https check on the final address was left out rather than guessed without a Windows machine to test on.
#
# Known limits compared with install.sh: Invoke-WebRequest cannot stop a download at a size cap, so the size is checked
# from Content-Length when the server sends it and from the file once it is on disk. Hard links in the extracted tree are
# not checked (PowerShell 5.1 has no link count), but the archive listing refuses them.
#
# The whole script runs in its own scope, so under `irm | iex` nothing (preferences, variables, functions) leaks into your
# session.
& {
  $ErrorActionPreference = "Stop"
  $ProgressPreference = "SilentlyContinue"

  $Repo = "MSpiechowicz/harness-useful-skills"
  $ReleaseApi = "https://api.github.com/repos/$Repo/releases/latest"
  $MaxArchiveBytes = [long]134217728
  $MaxExpandedBytes = [long]536870912
  $MaxEntries = 20000
  $MaxEntryName = 4096
  # Files a release must ship for its installer to set up OpenCode, and the manifests that carry its version.
  $RequiredFiles = @("useful-skills", "plugins/opencode/useful-skills.js")
  $VersionedManifests = @("package.json", "plugins/opencode/useful-skills/package.json")
  $VersionHint = "Set HARNESS_SKILLS_VERSION to a release tag (for example v0.3.7) and run this again."
  # The Windows tar. A GNU tar earlier on PATH (Git for Windows) reads C:\ paths as remote hosts.
  $TarExe = Join-Path $env:SystemRoot "System32\tar.exe"

  function Write-Step([string]$Message) { Write-Host "==> $Message" -ForegroundColor Cyan }

  # A release tag is vMAJOR.MINOR.PATCH, with or without the v. The value may come from the environment, so anything else
  # is refused before any download. \z, not $, so a trailing newline fails.
  function ConvertTo-ReleaseTag([string]$Value) {
    $Tag = if ($Value -match '^[0-9]') { "v$Value" } else { $Value }
    if ($Tag -cnotmatch '^v[0-9]+\.[0-9]+\.[0-9]+\z') { return $null }
    return $Tag
  }

  # Runs the Windows tar and fails on a non-zero exit. Returns its output lines.
  function Invoke-Tar([string[]]$TarArguments, [string]$Action) {
    $Output = @(& $TarExe @TarArguments)
    if ($LASTEXITCODE -ne 0) { throw "tar could not $Action the release archive." }
    return $Output
  }

  # The version field of a JSON file, or $null when the file or field is not usable.
  function Get-ManifestVersion([string]$Path) {
    try {
      $Value = (Get-Content -Raw -LiteralPath $Path | ConvertFrom-Json).version
      if ($Value -is [string]) { return $Value }
    } catch {
      Write-Verbose "Could not read ${Path}: $($_.Exception.Message)"
    }
    return $null
  }

  # The number of bytes the first gzip member expands to, counted without writing anything and stopping at $Limit.
  # A multi-member file can be counted short here: the sizes in the tar listing are checked as well.
  function Measure-Gzip([string]$Path, [long]$Limit) {
    $Total = [long]0
    $Buffer = New-Object byte[] 81920
    $File = [IO.File]::OpenRead($Path)
    try {
      $Gzip = New-Object IO.Compression.GzipStream($File, [IO.Compression.CompressionMode]::Decompress)
      try {
        while (($Read = $Gzip.Read($Buffer, 0, $Buffer.Length)) -gt 0) {
          $Total += $Read
          if ($Total -gt $Limit) { break }
        }
      } finally {
        $Gzip.Dispose()
      }
    } finally {
      $File.Dispose()
    }
    return $Total
  }

  # Sums the entry sizes of the verbose listing. The size column is found by anchoring on the trailing tokens, never on
  # text a user or group name could imitate, and never on the month (bsdtar prints it localized, like paz or Mar):
  #   bsdtar   ... size <month> D[D] HH:MM|YYYY name
  #   GNU tar  ... size YYYY-MM-DD HH:MM[:SS] name   (accepted too)
  # A line that fits neither shape, one entry above the limit, or a total above it is refused.
  function Measure-Listing([string[]]$Names, [string[]]$Details, [long]$Limit) {
    $Total = [long]0
    foreach ($Index in 0..($Names.Count - 1)) {
      $Name = $Names[$Index]
      $Line = $Details[$Index]
      if (-not $Line.EndsWith(" $Name", [StringComparison]::Ordinal)) {
        throw "Couldn't read the entry sizes of the release archive."
      }
      $Fields = @($Line.Substring(0, $Line.Length - $Name.Length - 1) -split '\s+' | Where-Object { $_ -ne "" })
      $Count = $Fields.Count
      $Size = $null
      if ($Count -ge 4 -and $Fields[$Count - 1] -cmatch '^([0-9]{1,2}:[0-9]{2}|[0-9]{4})$' -and $Fields[$Count - 2] -cmatch '^[0-9]{1,2}$') {
        $Size = $Fields[$Count - 4]
      } elseif ($Count -ge 3 -and $Fields[$Count - 1] -cmatch '^[0-9]{2}:[0-9]{2}(:[0-9]{2})?$' -and $Fields[$Count - 2] -cmatch '^[0-9]{4}-[0-9]{2}-[0-9]{2}$') {
        $Size = $Fields[$Count - 3]
      }
      if ($null -eq $Size -or $Size -cnotmatch '^[0-9]{1,15}$') { throw "Couldn't read the entry sizes of the release archive." }
      $Total += [long]$Size
      if ([long]$Size -gt $Limit -or $Total -gt $Limit) { throw "The release archive expands beyond the size limit." }
    }
  }

  if (-not (Test-Path -LiteralPath $TarExe -PathType Leaf)) {
    throw "Harness Skills needs the Windows tar ($TarExe), which comes with Windows 10 and newer."
  }
  if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
    throw "Harness Skills needs Node.js 22 or newer, but 'node' was not found on your PATH. Install it from https://nodejs.org and run this again."
  }
  $NodeVersion = ("$(& node -p 'process.versions.node')").Trim()
  if ($LASTEXITCODE -ne 0 -or $NodeVersion -cnotmatch '^[0-9]+\.') {
    throw "Harness Skills needs Node.js 22 or newer, but 'node -p process.versions.node' printed '$NodeVersion'. Install a current Node.js from https://nodejs.org and run this again."
  }
  if ([int]($NodeVersion -split '\.')[0] -lt 22) {
    throw "Harness Skills needs Node.js 22 or newer, but found $NodeVersion. Install a current Node.js from https://nodejs.org and run this again."
  }

  $Tag = $null
  # "latest" means the same as no value, as in install.sh.
  if ($env:HARNESS_SKILLS_VERSION -and $env:HARNESS_SKILLS_VERSION -cne "latest") {
    $Tag = ConvertTo-ReleaseTag $env:HARNESS_SKILLS_VERSION
    if (-not $Tag) { throw "Unexpected version: $($env:HARNESS_SKILLS_VERSION) (expected a release tag like v0.3.7)" }
  }

  # Add TLS 1.2 to what is allowed, keeping the machine's other protocols (Windows PowerShell 5.1 may default to old ones).
  # This setting is process-wide: it stays in effect in your PowerShell session after the script ends.
  [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12

  $Tmp = Join-Path ([IO.Path]::GetTempPath()) ([Guid]::NewGuid().ToString())
  New-Item -ItemType Directory -Path $Tmp | Out-Null
  Push-Location
  try {
    if (-not $Tag) {
      Write-Step "Looking up the latest release"
      try {
        $Release = Invoke-RestMethod -UseBasicParsing -Uri $ReleaseApi -Headers @{ "User-Agent" = "harness-skills-installer"; "Accept" = "application/vnd.github+json" }
      } catch {
        throw "Couldn't look up the latest release. $VersionHint"
      }
      # The API tag keeps its v, as in install.sh: no prefix is added to it.
      $Tag = if ($Release.tag_name -is [string] -and $Release.tag_name -cmatch '^v') { ConvertTo-ReleaseTag $Release.tag_name } else { $null }
      if (-not $Tag) { throw "GitHub did not return a usable release tag. $VersionHint" }
    }
    $VersionNumber = $Tag.Substring(1)

    $Archive = Join-Path $Tmp "release.tar.gz"
    $Url = "https://codeload.github.com/$Repo/tar.gz/refs/tags/$Tag"
    Write-Step "Downloading Harness Skills $Tag"
    # Best effort: refuse early when the server announces a size above the limit. Not every response carries one.
    try {
      $Head = Invoke-WebRequest -UseBasicParsing -Method Head -Uri $Url
      $Announced = @($Head.Headers["Content-Length"])[0]
      if ($Announced -and $Announced -match '^[0-9]+$' -and [long]$Announced -gt $MaxArchiveBytes) {
        throw "The release archive exceeds the download limit."
      }
    } catch {
      if ($_.Exception.Message -like "*download limit*") { throw }
      Write-Verbose "No size announced up front: $($_.Exception.Message)"
    }
    try {
      Invoke-WebRequest -UseBasicParsing -Uri $Url -OutFile $Archive
    } catch {
      throw "Download failed: $Url"
    }

    $ArchiveBytes = (Get-Item -LiteralPath $Archive).Length
    if ($ArchiveBytes -le 0) { throw "The release download was empty." }
    if ($ArchiveBytes -gt $MaxArchiveBytes) { throw "The release archive exceeds the download limit." }
    # Decompress without writing anything, so a small archive cannot expand into an unbounded tree.
    try {
      $Expanded = Measure-Gzip $Archive $MaxExpandedBytes
    } catch {
      throw "The release download is not a valid gzip archive."
    }
    if ($Expanded -le 0) { throw "The release download is not a valid gzip archive." }
    if ($Expanded -gt $MaxExpandedBytes) { throw "The release archive expands beyond the size limit." }

    # Check every entry before extracting anything: only regular files and directories, only relative names without dot
    # segments or trailing dots and spaces, sizes within the limit, and exactly one top-level directory.
    $Names = @(Invoke-Tar @("-tzf", $Archive) "list")
    $Details = @(Invoke-Tar @("-tvzf", $Archive) "list")
    if ($Names.Count -eq 0 -or $Names.Count -gt $MaxEntries -or $Names.Count -ne $Details.Count) {
      throw "The release archive listing is empty, too large, or inconsistent."
    }
    $Tops = @{}
    foreach ($Index in 0..($Names.Count - 1)) {
      $Name = [string]$Names[$Index]
      $Detail = [string]$Details[$Index]
      if ($Detail -cnotmatch '^[-d]' -or $Detail.Contains(" -> ") -or $Detail.Contains(" link to ")) {
        throw "The release archive contains an entry that is not a plain file or directory (links and special files are refused)."
      }
      # An entry without an owner write bit would be extracted read-only on Windows and could not be removed afterwards.
      if ($Detail -cnotmatch '^[-d].w') {
        throw "The release archive contains an entry without owner write permission (refused)."
      }
      $Trimmed = if ($Name.EndsWith("/")) { $Name.Substring(0, $Name.Length - 1) } else { $Name }
      $Parts = $Trimmed -split "/"
      # A colon is refused anywhere: a drive letter, or an alternate data stream (name:stream) on NTFS.
      if ($Name.Length -gt $MaxEntryName -or $Name -match '[\x00-\x1f\x7f\\:]' -or $Name.StartsWith("/") -or @($Parts | Where-Object { $_ -eq "" -or $_ -eq "." -or $_ -eq ".." -or $_ -cmatch '[. ]\z' }).Count -gt 0) {
        throw "The release archive contains an unsafe entry name."
      }
      $Tops[$Parts[0]] = $true
    }
    if ($Tops.Count -ne 1) { throw "The release archive must contain exactly one top-level directory." }
    $Top = @($Tops.Keys)[0]
    Measure-Listing $Names $Details $MaxExpandedBytes

    $Extract = Join-Path $Tmp "release"
    New-Item -ItemType Directory -Path $Extract | Out-Null
    Invoke-Tar @("--no-same-owner", "-xzf", $Archive, "-C", $Extract) "extract" | Out-Null

    # Walk the extracted tree without following links: nothing but plain files and directories may be there.
    foreach ($Item in Get-ChildItem -LiteralPath $Extract -Recurse -Force) {
      if ($Item.Attributes -band [IO.FileAttributes]::ReparsePoint) {
        throw "The extracted release contains a link (links are refused)."
      }
    }
    $Root = Join-Path $Extract $Top
    if (@(Get-ChildItem -LiteralPath $Extract -Force).Count -ne 1 -or -not (Test-Path -LiteralPath $Root -PathType Container)) {
      throw "The release archive must contain exactly one top-level directory."
    }

    # The release must be exactly the announced version and ship the OpenCode bundle and its installer.
    foreach ($Manifest in $VersionedManifests) {
      $Found = Get-ManifestVersion (Join-Path $Root $Manifest)
      if ($Found -ne $VersionNumber) {
        # Only a plain version is echoed: the value comes from the archive and could carry terminal escapes.
        $Shown = if ($Found -and $Found -cmatch '^v?[0-9]+\.[0-9]+\.[0-9]+\z') { $Found } else { "(missing or not a version)" }
        throw "The release archive $Manifest has version $Shown, expected $VersionNumber."
      }
    }
    foreach ($File in $RequiredFiles) {
      if (-not (Test-Path -LiteralPath (Join-Path $Root $File) -PathType Leaf)) {
        throw "The release archive has no $File, so it cannot install the OpenCode plugin."
      }
    }

    Write-Step "Installing Harness Skills $Tag for OpenCode"
    Set-Location -LiteralPath $HOME
    & node (Join-Path $Root "useful-skills") install --host opencode --scope user
    $Status = $LASTEXITCODE
    if ($Status -ne 0) { throw "The Harness Skills installer failed (exit $Status)." }

    Write-Host ""
    Write-Step "Restart OpenCode to load Harness Skills."
  } finally {
    Pop-Location
    # Cleanup never changes the outcome. Directory.Delete removes a link itself and does not follow it.
    try {
      # Read-only entries would make Delete fail: clear the attribute first.
      Get-ChildItem -LiteralPath $Tmp -Recurse -Force -ErrorAction SilentlyContinue | ForEach-Object { $_.Attributes = 'Normal' }
      [IO.Directory]::Delete($Tmp, $true)
    } catch {
      Write-Verbose "Could not remove ${Tmp}: $($_.Exception.Message)"
    }
  }
}

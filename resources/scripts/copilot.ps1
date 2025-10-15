# GitHub Copilot CLI wrapper script for PowerShell
# This script checks for copilot installation and version compatibility

# Minimum required Copilot CLI version
$RequiredVersion = "0.0.339"

function Find-RealCopilot {
    # Find the real copilot binary, avoiding this script if it's in PATH
    $CurrentScript = $MyInvocation.PSCommandPath
    if (-not $CurrentScript) { $CurrentScript = $PSCommandPath }
    $CopilotPath = (Get-Command copilot -ErrorAction SilentlyContinue).Source

    # Check if the copilot command would point to this script
    if ($CurrentScript -eq $CopilotPath -or (Resolve-Path $CurrentScript -ErrorAction SilentlyContinue).Path -eq (Resolve-Path $CopilotPath -ErrorAction SilentlyContinue).Path) {
        # The copilot in PATH is this script, find the real one by temporarily removing this script's directory from PATH
        $ScriptDir = Split-Path $CurrentScript -Parent
        $OldPath = $env:PATH
        # Use appropriate path delimiter based on OS
        $PathDelimiter = if ($IsWindows -or $env:OS -eq "Windows_NT") { ';' } else { ':' }
        $env:PATH = ($env:PATH -split $PathDelimiter | Where-Object { $_ -ne $ScriptDir }) -join $PathDelimiter
        $RealCopilot = (Get-Command copilot -ErrorAction SilentlyContinue).Source
        $env:PATH = $OldPath
        
        if ($RealCopilot -and (Test-Path $RealCopilot)) {
            return $RealCopilot
        } else {
            return $null
        }
    } else {
        # The copilot in PATH is different from this script, use it
        if ($CopilotPath -and (Test-Path $CopilotPath)) {
            return $CopilotPath
        } else {
            return $null
        }
    }
}

function Test-VersionCompatibility {
    param([string]$Version)
    $cleanInstalled = $Version -replace '^v',''
    $cleanRequired = $RequiredVersion -replace '^v',''
    try {
        $installedVer = [version]$cleanInstalled
        $requiredVer = [version]$cleanRequired
    } catch {
        return $false
    }
    return ($installedVer -ge $requiredVer)
}

function Test-AndLaunchCopilot {
    param([string[]]$Arguments)
    
    # Check if real copilot command exists
    $realCopilot = Find-RealCopilot
    if (-not $realCopilot) {
        Write-Host "GitHub Copilot CLI is not installed."
        $answer = Read-Host "Would you like to install it now? (y/N)"
        if ($answer -eq "y" -or $answer -eq "Y") {
            Write-Host "Installing GitHub Copilot CLI..."
            try {
                & npm install -g @github/copilot
                if ($LASTEXITCODE -eq 0) {
                    Write-Host "Installation completed successfully."
                    Test-AndLaunchCopilot $Arguments
                    return
                } else {
                    Write-Host "Installation failed. Please check your npm configuration and try again."
                    exit 1
                }
            } catch {
                Write-Host "Installation failed. Please check your npm configuration and try again."
                exit 1
            }
        } else {
            Write-Host "Installation cancelled."
            exit 0
        }
    }

    # Check version compatibility
    $realCopilot = Find-RealCopilot
    if (-not $realCopilot) {
        Write-Host "Error: Unable to find copilot binary."
        $answer = Read-Host "Would you like to reinstall GitHub Copilot CLI? (y/N)"
        if ($answer -eq "y" -or $answer -eq "Y") {
            Write-Host "Reinstalling GitHub Copilot CLI..."
            try {
                & npm install -g @github/copilot
                if ($LASTEXITCODE -eq 0) {
                    Write-Host "Reinstallation completed successfully."
                    Test-AndLaunchCopilot $Arguments
                    return
                } else {
                    Write-Host "Reinstallation failed. Please check your npm configuration and try again."
                    exit 1
                }
            } catch {
                Write-Host "Reinstallation failed. Please check your npm configuration and try again."
                exit 1
            }
        } else {
            Write-Host "Reinstallation cancelled."
            exit 0
        }
    }
    
    try {
        $versionOutput = & $realCopilot --version 2>$null
        if ($LASTEXITCODE -ne 0) {
            throw "Command failed"
        }
    } catch {
        # Write-Host "Error: Unable to check copilot version."
        $answer = Read-Host "Would you like to reinstall GitHub Copilot CLI? (y/N)"
        if ($answer -eq "y" -or $answer -eq "Y") {
            Write-Host "Reinstalling GitHub Copilot CLI..."
            try {
                & npm install -g @github/copilot
                if ($LASTEXITCODE -eq 0) {
                    Write-Host "Reinstallation completed successfully."
                    Test-AndLaunchCopilot $Arguments
                    return
                } else {
                    Write-Host "Reinstallation failed. Please check your npm configuration and try again."
                    exit 1
                }
            } catch {
                Write-Host "Reinstallation failed. Please check your npm configuration and try again."
                exit 1
            }
        } else {
            Write-Host "Reinstallation cancelled."
            exit 0
        }
    }

    # Extract version number from output
    $version = if ($versionOutput -match '[0-9]+\.[0-9]+\.[0-9]+') { $matches[0] } else { $null }

    if (-not $version) {
        Write-Host "Error: Unable to parse copilot version from: $versionOutput"
        $answer = Read-Host "Would you like to reinstall GitHub Copilot CLI? (y/N)"
        if ($answer -eq "y" -or $answer -eq "Y") {
            Write-Host "Reinstalling GitHub Copilot CLI..."
            try {
                & npm install -g @github/copilot
                if ($LASTEXITCODE -eq 0) {
                    Write-Host "Reinstallation completed successfully."
                    Test-AndLaunchCopilot $Arguments
                    return
                } else {
                    Write-Host "Reinstallation failed. Please check your npm configuration and try again."
                    exit 1
                }
            } catch {
                Write-Host "Reinstallation failed. Please check your npm configuration and try again."
                exit 1
            }
        } else {
            Write-Host "Reinstallation cancelled."
            exit 0
        }
    }

    if (-not (Test-VersionCompatibility $version)) {
        Write-Host "GitHub Copilot CLI version $version is not compatible."
        Write-Host "Version $RequiredVersion or later is required."
        $answer = Read-Host "Would you like to update it now? (y/N)"
        if ($answer -eq "y" -or $answer -eq "Y") {
            Write-Host "Updating GitHub Copilot CLI..."
            try {
                & npm update -g @github/copilot
                if ($LASTEXITCODE -eq 0) {
                    Write-Host "Update completed successfully."
                    Test-AndLaunchCopilot $Arguments
                    return
                } else {
                    Write-Host "Update failed. Please check your npm configuration and try again."
                    exit 1
                }
            } catch {
                Write-Host "Update failed. Please check your npm configuration and try again."
                exit 1
            }
        } else {
            Write-Host "Update cancelled."
            exit 0
        }
    }

    # All checks passed, execute the real copilot binary
    $realCopilot = Find-RealCopilot
    if ($realCopilot -and (Test-Path $realCopilot)) {
        & $realCopilot @Arguments
    } else {
        Write-Host "Error: Could not find the real GitHub Copilot CLI binary"
        Write-Host "Please ensure it's properly installed with: npm install -g @github/copilot"
        exit 1
    }
}

# Start the check and launch process
Test-AndLaunchCopilot $args
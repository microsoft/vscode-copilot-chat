#!/bin/csh

# GitHub Copilot CLI wrapper script for csh/tcsh
# This script checks for copilot installation and version compatibility

# Minimum required Copilot CLI version
set required_version = "0.0.339"

start_copilot:

# Find the real copilot binary, avoiding this script if it's in PATH
set current_script = "`realpath '$0' 2>/dev/null || readlink -f '$0' 2>/dev/null || echo '$0'`"
set copilot_path = "`which copilot 2>/dev/null`"
set real_copilot = ""

# Check if the copilot command would point to this script
set current_realpath = "`realpath '$copilot_path' 2>/dev/null || echo '$copilot_path'`"
if ( "$current_script" == "$copilot_path" || "$current_script" == "$current_realpath" ) then
    # The copilot in PATH is this script, find the real one by temporarily removing this script's directory from PATH
    set script_dir = "`dirname '$current_script'`"
    set old_path = "$PATH"
    setenv PATH "`echo '$PATH' | sed 's|:*$script_dir:*|:|g' | sed 's/^://;s/:$//'`"
    set real_copilot = "`which copilot 2>/dev/null`"
    setenv PATH "$old_path"
else
    # The copilot in PATH is different from this script, use it
    set real_copilot = "$copilot_path"
endif

# Check if real copilot command exists
if ("$real_copilot" == "" || ! -x "$real_copilot") then
    echo "GitHub Copilot CLI is not installed."
    echo -n "Would you like to install it now? (y/N): "
    set answer = $<
    if ("$answer" == "y" || "$answer" == "Y") then
        echo "Installing GitHub Copilot CLI..."
        npm install -g @github/copilot
        if ($status == 0) then
            echo "Installation completed successfully."
            goto start_copilot
        else
            echo "Installation failed. Please check your npm configuration and try again."
            exit 1
        endif
    else
        echo "Installation cancelled."
        exit 0
    endif
endif

# Check version compatibility using the real copilot binary
set version_output = `"$real_copilot" --version 2>/dev/null`
if ($status != 0) then
    echo "Error: Unable to check copilot version."
    echo -n "Would you like to reinstall GitHub Copilot CLI? (y/N): "
    set answer = $<
    if ("$answer" == "y" || "$answer" == "Y") then
        echo "Reinstalling GitHub Copilot CLI..."
        npm install -g @github/copilot
        if ($status == 0) then
            echo "Reinstallation completed successfully."
            goto start_copilot
        else
            echo "Reinstallation failed. Please check your npm configuration and try again."
            exit 1
        endif
    else
        echo "Reinstallation cancelled."
        exit 0
    endif
endif

# Extract version number from output
set version = `echo "$version_output" | grep -oE '[0-9]+\.[0-9]+\.[0-9]+' | head -1`

if ("$version" == "") then
    echo "Error: Unable to parse copilot version from: $version_output"
    echo -n "Would you like to reinstall GitHub Copilot CLI? (y/N): "
    set answer = $<
    if ("$answer" == "y" || "$answer" == "Y") then
        echo "Reinstalling GitHub Copilot CLI..."
        npm install -g @github/copilot
        if ($status == 0) then
            echo "Reinstallation completed successfully."
            goto start_copilot
        else
            echo "Reinstallation failed. Please check your npm configuration and try again."
            exit 1
        endif
    else
        echo "Reinstallation cancelled."
        exit 0
    endif
endif

set version_clean = `echo "$version" | sed 's/^v//'`
set installed_parts = `echo "$version_clean" | sed 's/\./ /g'`
set ins_major = 0
set ins_minor = 0
set ins_patch = 0
if ($#installed_parts >= 1) set ins_major = $installed_parts[1]
if ($#installed_parts >= 2) set ins_minor = $installed_parts[2]
if ($#installed_parts >= 3) set ins_patch = $installed_parts[3]

set req_clean = `echo "$required_version" | sed 's/^v//'`
set req_parts = `echo "$req_clean" | sed 's/\./ /g'`
set req_major = 0
set req_minor = 0
set req_patch = 0
if ($#req_parts >= 1) set req_major = $req_parts[1]
if ($#req_parts >= 2) set req_minor = $req_parts[2]
if ($#req_parts >= 3) set req_patch = $req_parts[3]

set compatible = 0
if ($ins_major > $req_major) then
    set compatible = 1
else if ($ins_major == $req_major) then
    if ($ins_minor > $req_minor) then
        set compatible = 1
    else if ($ins_minor == $req_minor) then
        if ($ins_patch >= $req_patch) set compatible = 1
    endif
endif

if ($compatible == 0) then
    echo "GitHub Copilot CLI version $version is not compatible."
    echo "Version $required_version or later is required."
    echo -n "Would you like to update it now? (y/N): "
    set answer = $<
    if ("$answer" == "y" || "$answer" == "Y") then
        echo "Updating GitHub Copilot CLI..."
        npm update -g @github/copilot
        if ($status == 0) then
            echo "Update completed successfully."
            goto start_copilot
        else
            echo "Update failed. Please check your npm configuration and try again."
            exit 1
        endif
    else
        echo "Update cancelled."
        exit 0
    endif
endif

# All checks passed, execute the real copilot binary
if ( "$real_copilot" != "" && -x "$real_copilot" ) then
    exec "$real_copilot" $argv
else
    echo "Error: Could not find the real GitHub Copilot CLI binary"
    echo "Please ensure it's properly installed with: npm install -g @github/copilot"
    exit 1
endif
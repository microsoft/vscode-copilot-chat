#!/bin/bash

# GitHub Copilot CLI wrapper script for bash/zsh
# This script checks for copilot installation and version compatibility

# Minimum required Copilot CLI version (semantic version major.minor.patch)
REQUIRED_VERSION="0.0.339"

find_real_copilot() {
    # Find the real copilot binary, avoiding this script if it's in PATH
    local current_script=$(realpath "$0" 2>/dev/null || readlink -f "$0" 2>/dev/null || echo "$0")
    local copilot_path=$(which copilot 2>/dev/null)
    
    # Check if the copilot command would point to this script
    if [ "$current_script" = "$copilot_path" ] || [ "$current_script" = "$(realpath "$copilot_path" 2>/dev/null)" ]; then
        # The copilot in PATH is this script, find the real one by temporarily removing this script's directory from PATH
        local script_dir=$(dirname "$current_script")
        local old_path="$PATH"
        export PATH=$(echo "$PATH" | sed "s|:*${script_dir}:*|:|g" | sed 's/^://;s/:$//')
        local real_copilot=$(which copilot 2>/dev/null)
        export PATH="$old_path"
        
        if [ -n "$real_copilot" ] && [ -x "$real_copilot" ]; then
            echo "$real_copilot"
            return 0
        else
            return 1
        fi
    else
        # The copilot in PATH is different from this script, use it
        if [ -n "$copilot_path" ] && [ -x "$copilot_path" ]; then
            echo "$copilot_path"
            return 0
        else
            return 1
        fi
    fi
}

parse_version_parts() {
    # Usage: parse_version_parts <version_string>
    # Outputs three space-separated numeric components (major minor patch)
    local v="$1"
    v=${v#v} # strip leading v
    IFS='.' read -r major minor patch <<< "$v"
    [ -z "$major" ] && major=0
    [ -z "$minor" ] && minor=0
    [ -z "$patch" ] && patch=0
    # Remove any non-digit suffix (e.g., 1.2.3-beta -> 1.2.3)
    major=${major%%[^0-9]*}
    minor=${minor%%[^0-9]*}
    patch=${patch%%[^0-9]*}
    echo "$major $minor $patch"
}

check_version_compatibility() {
    local installed_version="$1"
    local required_version="$REQUIRED_VERSION"

    read -r req_major req_minor req_patch <<< "$(parse_version_parts "$required_version")"
    read -r ins_major ins_minor ins_patch <<< "$(parse_version_parts "$installed_version")"

    # Piecewise numeric comparison
    if [ "$ins_major" -gt "$req_major" ]; then return 0; fi
    if [ "$ins_major" -lt "$req_major" ]; then return 1; fi
    if [ "$ins_minor" -gt "$req_minor" ]; then return 0; fi
    if [ "$ins_minor" -lt "$req_minor" ]; then return 1; fi
    if [ "$ins_patch" -ge "$req_patch" ]; then return 0; else return 1; fi
}

check_and_launch() {
    # Check if real copilot command exists
    real_copilot=$(find_real_copilot 2>/dev/null)
    if [ -z "$real_copilot" ]; then
        echo "GitHub Copilot CLI is not installed."
        read -p "Would you like to install it now? (y/N): " -n 1 -r
        echo
        if [[ $REPLY =~ ^[Yy]$ ]]; then
            echo "Installing GitHub Copilot CLI..."
            if npm install -g @github/copilot; then
                echo "Installation completed successfully."
                check_and_launch "$@"  # Restart the check process
                return
            else
                echo "Installation failed. Please check your npm configuration and try again."
                exit 1
            fi
        else
            echo "Installation cancelled."
            exit 0
        fi
    fi

    # Check version compatibility
    real_copilot=$(find_real_copilot 2>/dev/null)
    if [ -z "$real_copilot" ]; then
        echo "Error: Unable to find copilot binary."
        read -p "Would you like to reinstall GitHub Copilot CLI? (y/N): " -n 1 -r
        echo
        if [[ $REPLY =~ ^[Yy]$ ]]; then
            echo "Reinstalling GitHub Copilot CLI..."
            if npm install -g @github/copilot; then
                echo "Reinstallation completed successfully."
                check_and_launch "$@"  # Restart the check process
                return
            else
                echo "Reinstallation failed. Please check your npm configuration and try again."
                exit 1
            fi
        else
            echo "Reinstallation cancelled."
            exit 0
        fi
    fi
    
    version_output=$("$real_copilot" --version 2>/dev/null)
    if [ $? -ne 0 ]; then
        echo "Error: Unable to check copilot version."
        read -p "Would you like to reinstall GitHub Copilot CLI? (y/N): " -n 1 -r
        echo
        if [[ $REPLY =~ ^[Yy]$ ]]; then
            echo "Reinstalling GitHub Copilot CLI..."
            if npm install -g @github/copilot; then
                echo "Reinstallation completed successfully."
                check_and_launch "$@"  # Restart the check process
                return
            else
                echo "Reinstallation failed. Please check your npm configuration and try again."
                exit 1
            fi
        else
            echo "Reinstallation cancelled."
            exit 0
        fi
    fi

    # Extract version number from output
    version=$(echo "$version_output" | grep -oE '[0-9]+\.[0-9]+\.[0-9]+' | head -1)

    if [ -z "$version" ]; then
        echo "Error: Unable to parse copilot version from: $version_output"
        read -p "Would you like to reinstall GitHub Copilot CLI? (y/N): " -n 1 -r
        echo
        if [[ $REPLY =~ ^[Yy]$ ]]; then
            echo "Reinstalling GitHub Copilot CLI..."
            if npm install -g @github/copilot; then
                echo "Reinstallation completed successfully."
                check_and_launch "$@"  # Restart the check process
                return
            else
                echo "Reinstallation failed. Please check your npm configuration and try again."
                exit 1
            fi
        else
            echo "Reinstallation cancelled."
            exit 0
        fi
    fi

    if ! check_version_compatibility "$version"; then
        echo "GitHub Copilot CLI version $version is not compatible."
        echo "Version $REQUIRED_VERSION or later is required."
        read -p "Would you like to update it now? (y/N): " -n 1 -r
        echo
        if [[ $REPLY =~ ^[Yy]$ ]]; then
            echo "Updating GitHub Copilot CLI..."
            if npm update -g @github/copilot; then
                echo "Update completed successfully."
                check_and_launch "$@"  # Restart the check process
                return
            else
                echo "Update failed. Please check your npm configuration and try again."
                exit 1
            fi
        else
            echo "Update cancelled."
            exit 0
        fi
    fi

    # All checks passed, execute the real copilot binary
    real_copilot=$(find_real_copilot 2>/dev/null)
    if [ -n "$real_copilot" ] && [ -x "$real_copilot" ]; then
        exec "$real_copilot" "$@"
    else
        echo "Error: Could not find the real GitHub Copilot CLI binary"
        echo "Please ensure it's properly installed with: npm install -g @github/copilot"
        exit 1
    fi
}

# Start the check and launch process
check_and_launch "$@"
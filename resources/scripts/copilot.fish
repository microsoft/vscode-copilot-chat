#!/usr/bin/env fish

# GitHub Copilot CLI wrapper script for fish shell
# This script checks for copilot installation and version compatibility

# Minimum required Copilot CLI version
set REQUIRED_VERSION "0.0.339"

function find_real_copilot
    # Find the real copilot binary, avoiding this script if it's in PATH
    set current_script (realpath (status current-filename) 2>/dev/null; or readlink -f (status current-filename) 2>/dev/null; or echo (status current-filename))
    set copilot_path (which copilot 2>/dev/null)
    
    # Check if the copilot command would point to this script
    set copilot_realpath (realpath "$copilot_path" 2>/dev/null; or echo "$copilot_path")
    if test "$current_script" = "$copilot_path"; or test "$current_script" = "$copilot_realpath"
        # The copilot in PATH is this script, find the real one by temporarily removing this script's directory from PATH
        set script_dir (dirname "$current_script")
        set old_path $PATH
        set -x PATH (string replace -a ":$script_dir:" ":" "$PATH" | string replace -r "^$script_dir:" "" | string replace -r ":$script_dir\$" "" | string replace -r "^$script_dir\$" "")
        set real_copilot (which copilot 2>/dev/null)
        set -x PATH $old_path
        
        if test -n "$real_copilot" -a -x "$real_copilot"
            echo "$real_copilot"
            return 0
        else
            return 1
        end
    else
        # The copilot in PATH is different from this script, use it
        if test -n "$copilot_path" -a -x "$copilot_path"
            echo "$copilot_path"
            return 0
        else
            return 1
        end
    end
end

function __parse_version_parts
    set v (string replace -r '^v' '' $argv[1])
    set parts (string split '.' $v)
    set major 0; set minor 0; set patch 0
    if test (count $parts) -ge 1; set major (string replace -r '[^0-9].*$' '' $parts[1]); end
    if test (count $parts) -ge 2; set minor (string replace -r '[^0-9].*$' '' $parts[2]); end
    if test (count $parts) -ge 3; set patch (string replace -r '[^0-9].*$' '' $parts[3]); end
    echo "$major $minor $patch"
end

function check_version_compatibility
    set installed $argv[1]
    set req_parts (__parse_version_parts $REQUIRED_VERSION)
    set ins_parts (__parse_version_parts $installed)
    set req_major (echo $req_parts | awk '{print $1}')
    set req_minor (echo $req_parts | awk '{print $2}')
    set req_patch (echo $req_parts | awk '{print $3}')
    set ins_major (echo $ins_parts | awk '{print $1}')
    set ins_minor (echo $ins_parts | awk '{print $2}')
    set ins_patch (echo $ins_parts | awk '{print $3}')

    if test (math $ins_major) -gt (math $req_major)
        return 0
    else if test (math $ins_major) -lt (math $req_major)
        return 1
    end
    if test (math $ins_minor) -gt (math $req_minor)
        return 0
    else if test (math $ins_minor) -lt (math $req_minor)
        return 1
    end
    if test (math $ins_patch) -ge (math $req_patch)
        return 0
    end
    return 1
end

function check_and_launch
    # Check if real copilot command exists
    set real_copilot (find_real_copilot 2>/dev/null)
    if test -z "$real_copilot"
        echo "GitHub Copilot CLI is not installed."
        echo -n "Would you like to install it now? (y/N): "
        read -l answer
        if test "$answer" = "y" -o "$answer" = "Y"
            echo "Installing GitHub Copilot CLI..."
            if npm install -g @github/copilot
                echo "Installation completed successfully."
                check_and_launch $argv
                return
            else
                echo "Installation failed. Please check your npm configuration and try again."
                exit 1
            end
        else
            echo "Installation cancelled."
            exit 0
        end
    end

    # Check version compatibility
    set real_copilot (find_real_copilot 2>/dev/null)
    if test -z "$real_copilot"
        echo "Error: Unable to find copilot binary."
        echo -n "Would you like to reinstall GitHub Copilot CLI? (y/N): "
        read -l answer
        if test "$answer" = "y" -o "$answer" = "Y"
            echo "Reinstalling GitHub Copilot CLI..."
            if npm install -g @github/copilot
                echo "Reinstallation completed successfully."
                check_and_launch $argv
                return
            else
                echo "Reinstallation failed. Please check your npm configuration and try again."
                exit 1
            end
        else
            echo "Reinstallation cancelled."
            exit 0
        end
    end
    
    set version_output ("$real_copilot" --version 2>/dev/null)
    if test $status -ne 0
        echo "Error: Unable to check copilot version."
        echo -n "Would you like to reinstall GitHub Copilot CLI? (y/N): "
        read -l answer
        if test "$answer" = "y" -o "$answer" = "Y"
            echo "Reinstalling GitHub Copilot CLI..."
            if npm install -g @github/copilot
                echo "Reinstallation completed successfully."
                check_and_launch $argv
                return
            else
                echo "Reinstallation failed. Please check your npm configuration and try again."
                exit 1
            end
        else
            echo "Reinstallation cancelled."
            exit 0
        end
    end

    # Extract version number from output
    set version (string match -r '[0-9]+\.[0-9]+\.[0-9]+' "$version_output")

    if test -z "$version"
        echo "Error: Unable to parse copilot version from: $version_output"
        echo -n "Would you like to reinstall GitHub Copilot CLI? (y/N): "
        read -l answer
        if test "$answer" = "y" -o "$answer" = "Y"
            echo "Reinstalling GitHub Copilot CLI..."
            if npm install -g @github/copilot
                echo "Reinstallation completed successfully."
                check_and_launch $argv
                return
            else
                echo "Reinstallation failed. Please check your npm configuration and try again."
                exit 1
            end
        else
            echo "Reinstallation cancelled."
            exit 0
        end
    end

    if not check_version_compatibility "$version"
        echo "GitHub Copilot CLI version $version is not compatible."
        echo "Version $REQUIRED_VERSION or later is required."
        echo -n "Would you like to update it now? (y/N): "
        read -l answer
        if test "$answer" = "y" -o "$answer" = "Y"
            echo "Updating GitHub Copilot CLI..."
            if npm update -g @github/copilot
                echo "Update completed successfully."
                check_and_launch $argv
                return
            else
                echo "Update failed. Please check your npm configuration and try again."
                exit 1
            end
        else
            echo "Update cancelled."
            exit 0
        end
    end

    # All checks passed, execute the real copilot binary
    set real_copilot (find_real_copilot 2>/dev/null)
    if test -n "$real_copilot" -a -x "$real_copilot"
        exec "$real_copilot" $argv
    else
        echo "Error: Could not find the real GitHub Copilot CLI binary"
        echo "Please ensure it's properly installed with: npm install -g @github/copilot"
        exit 1
    end
end

# Start the check and launch process
check_and_launch $argv
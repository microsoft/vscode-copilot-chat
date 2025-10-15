#!/usr/bin/env nu
# GitHub Copilot CLI wrapper script for Nushell
# Mirrors logic of bash/fish/powershell wrappers:
#  - Ensure GitHub Copilot CLI installed
#  - Verify minimum required version
#  - Offer install / reinstall / update interactively
#  - Execute the real copilot binary

const REQUIRED_VERSION = "0.0.339"

# Find the real copilot binary (avoid infinite recursion if THIS script is the first hit)
def find-real-copilot [] {
    # which returns a table of matches (name, path, type)
    let matches = (which copilot | where type == "file")
    if ($matches | is-empty) { return null }

    let script_path = (try { $nu.script-path } catch { null })
    if $script_path == null {
        # Fallback: just return first match
        return ($matches | get 0 | get path)
    }

    let script_basename = (basename $script_path)

    # If first match points to this script (or same real path), try to find another
    let first = ($matches | get 0 | get path)
    let first_real = (try { realpath $first } catch { $first })
    let script_real = (try { realpath $script_path } catch { $script_path })

    if $first_real == $script_real or ($script_basename in ["copilot.nu" "copilot"]) and $first_real ends-with "copilot.nu" {
        let alt = ($matches | skip 1 | where {|r| (try { realpath $r.path } catch { $r.path }) != $script_real } | get 0? | get path?)
        if $alt != null { return $alt } else { return null }
    } else {
        return $first
    }
}

# Parse semantic version into record {major, minor, patch}
def parse-version [v:string] {
    let cleaned = ($v | str trim | str replace -r '^v' '' )
    let parts = ($cleaned | split row '.')
    let major = (try { ($parts | get 0 | str replace -r '[^0-9].*$' '') } catch { "0" })
    let minor = (try { ($parts | get 1 | str replace -r '[^0-9].*$' '') } catch { "0" })
    let patch = (try { ($parts | get 2 | str replace -r '[^0-9].*$' '') } catch { "0" })
    { major: ($major | into int), minor: ($minor | into int), patch: ($patch | into int) }
}

# Return true if installed >= required
def version-compatible [installed:string required:string] {
    let i = (parse-version $installed)
    let r = (parse-version $required)
    if $i.major > $r.major { return true }
    if $i.major < $r.major { return false }
    if $i.minor > $r.minor { return true }
    if $i.minor < $r.minor { return false }
    if $i.patch >= $r.patch { return true } else { return false }
}

# Prompt helper returning y/n boolean
def prompt-yes [message:string] {
    let ans = (input $"($message) (y/N): " | str trim)
    ($ans | str downcase) in ["y" "yes"]
}

# Attempt an npm command; return success bool
def do-npm [args:list<string>] {
    try { ^npm ...$args; true } catch { false }
}

# Core check + launch logic (recursive after install/update)
def check-and-launch [...args] {
    mut real = (find-real-copilot)
    if $real == null {
        if (prompt-yes "GitHub Copilot CLI is not installed. Install now?") {
            if (do-npm ["install" "-g" "@github/copilot"]) {
                print "Installation completed successfully.";
                return (check-and-launch ...$args)
            } else {
                print "Installation failed. Please check your npm configuration and try again."; exit 1
            }
        } else { print "Installation cancelled."; exit 0 }
    }

    # Re-resolve after potential install
    real = (find-real-copilot)
    if $real == null {
        if (prompt-yes "Error: Unable to find copilot binary. Reinstall?") {
            if (do-npm ["install" "-g" "@github/copilot"]) {
                print "Reinstallation completed successfully.";
                return (check-and-launch ...$args)
            } else { print "Reinstallation failed. Please check your npm configuration and try again."; exit 1 }
        } else { print "Reinstallation cancelled."; exit 0 }
    }

    # Get version output
    let version_output = (try { ^$real --version } catch { null })
    if $version_output == null {
        if (prompt-yes "Error: Unable to check copilot version. Reinstall?") {
            if (do-npm ["install" "-g" "@github/copilot"]) {
                print "Reinstallation completed successfully."; return (check-and-launch ...$args)
            } else { print "Reinstallation failed. Please check your npm configuration and try again."; exit 1 }
        } else { print "Reinstallation cancelled."; exit 0 }
    }

    # Extract first semver
    let version = ($version_output | lines | str join " " | str find-replace -a -r '.*?([0-9]+\.[0-9]+\.[0-9]+).*' '$1')
    if ($version | str contains '.') == false {
        if (prompt-yes $"Error: Unable to parse copilot version from: ($version_output). Reinstall?") {
            if (do-npm ["install" "-g" "@github/copilot"]) {
                print "Reinstallation completed successfully."; return (check-and-launch ...$args)
            } else { print "Reinstallation failed. Please check your npm configuration and try again."; exit 1 }
        } else { print "Reinstallation cancelled."; exit 0 }
    }

    if (version-compatible $version $REQUIRED_VERSION) == false {
        print $"GitHub Copilot CLI version ($version) is not compatible."
        print $"Version ($REQUIRED_VERSION) or later is required."
        if (prompt-yes "Update now?") {
            if (do-npm ["update" "-g" "@github/copilot"]) {
                print "Update completed successfully."; return (check-and-launch ...$args)
            } else { print "Update failed. Please check your npm configuration and try again."; exit 1 }
        } else { print "Update cancelled."; exit 0 }
    }

    # Final execution
    real = (find-real-copilot)
    if $real == null {
        print "Error: Could not find the real GitHub Copilot CLI binary"
        print "Please ensure it's properly installed with: npm install -g @github/copilot"
        exit 1
    }

    # Execute, replacing current process (closest analogue: just run and exit with its status)
    try {
        run-external $real ...$args
    } catch {
        print "Error: Execution failed"; exit 1
    }
}

# Entry point
check-and-launch ...$argv

#!/usr/bin/env bash
# Git LFS and Husky Integration Script
#
# PURPOSE: Resolves conflicts between Git LFS and Husky hook management
# by merging Git LFS hooks into Husky's hook structure.
#
# PROBLEM: When using both Git LFS and Husky in a project, their hook management
# systems can conflict. Husky sets core.hooksPath to .husky/_, but Git LFS
# expects hooks in the standard location or its own registered location.
#
# USAGE:
#   ./fix-lfs-husky-hooks.sh               # Interactive mode
#   ./fix-lfs-husky-hooks.sh --auto        # Automatic mode, no prompts

set -eo pipefail

# Configuration
HUSKY_DIR=".husky"
HUSKY_TEMPLATES_DIR="$HUSKY_DIR/_"
BACKUP_DIR="$HUSKY_DIR/_backups/$(date +%Y%m%d_%H%M%S)"
HOOKS=("pre-push" "post-checkout" "post-commit" "post-merge")
AUTO_MODE=false

# Process arguments
case "${1:-}" in
    --auto|--autoMergeLfsHusky)
        AUTO_MODE=true
        ;;
    --help|-h)
        cat << EOF
Usage: $0 [--auto] [--help]

Options:
  --auto    Run in automatic mode without prompts
  --help    Show this help message
EOF
        exit 0
        ;;
    "")
        # No arguments, continue with interactive mode
        ;;
    *)
        echo "Unknown option: $1" >&2
        echo "Use --help for usage information" >&2
        exit 1
        ;;
esac

is_git_lfs_configured() {
    # Check for .gitattributes with LFS filters
    [ -f ".gitattributes" ] && grep -q "filter=lfs" ".gitattributes" && return 0

    # Check if any LFS pointers exist in the repo
    git lfs ls-files 2>/dev/null | grep -q . && return 0

    # Check Git config for LFS settings
    git config --local --get-regexp "lfs" | grep -q . && return 0

    return 1
}

validate_environment() {
    # Check if we're in a git repository
    git rev-parse --is-inside-work-tree >/dev/null 2>&1 || {
        echo "Error: Not in a git repository" >&2
        exit 1
    }

    # Check if Husky is configured
    [ -d "$HUSKY_DIR" ] || {
        echo "Error: Husky directory '$HUSKY_DIR' not found" >&2
        exit 1
    }

    # Check if Git LFS is installed
    if ! command -v git-lfs >/dev/null 2>&1; then
        echo "Warning: Git LFS is not installed" >&2
        if [ "$AUTO_MODE" = false ]; then
            read -p "Continue anyway? (y/N): " confirm
            [[ "$confirm" == [yY] ]] || exit 0
        else
            echo "Error: Git LFS is not installed and --auto mode is enabled" >&2
            exit 1
        fi
    fi

    # Check if Git LFS is actually configured in this repository
    if ! is_git_lfs_configured; then
        echo "Warning: Git LFS does not appear to be configured in this repository" >&2
        if [ "$AUTO_MODE" = false ]; then
            read -p "Continue anyway? (y/N): " confirm
            [[ "$confirm" == [yY] ]] || exit 0
        else
            echo "Skipping hook modifications as Git LFS is not configured"
            exit 0
        fi
    fi
}

# Create backup of existing hooks that need modification
backup_hooks() {
    local needs_backup=false

    for hook in "${HOOKS[@]}"; do
        if [ -f "$HUSKY_TEMPLATES_DIR/$hook" ] && ! grep -q "=== BEGIN GIT LFS HOOK" "$HUSKY_TEMPLATES_DIR/$hook"; then
            needs_backup=true
            break
        fi
    done

    [ "$needs_backup" = false ] && {
        echo "No backup needed - all hooks already configured"
        return
    }

    echo "Creating backup in $BACKUP_DIR"
    mkdir -p "$BACKUP_DIR"

    for hook in "${HOOKS[@]}"; do
        [ -f "$HUSKY_TEMPLATES_DIR/$hook" ] && {
            cp "$HUSKY_TEMPLATES_DIR/$hook" "$BACKUP_DIR/$hook"
            echo "✓ Backed up $hook"
        }
    done
}

# Generate Git LFS hook content
generate_lfs_hook() {
    local hook_type="$1"
    cat << EOF
# === BEGIN GIT LFS HOOK (added by fix-lfs-husky-hooks.sh) ===
command -v git-lfs >/dev/null 2>&1 || {
    printf >&2 "\nThis repository is configured for Git LFS but 'git-lfs' was not found on your path.\n"
    printf >&2 "If you no longer wish to use Git LFS, remove this hook by deleting the '$hook_type' file.\n\n"
    exit 2
}
git lfs $hook_type "\$@"
# === END GIT LFS HOOK ===
EOF
}

merge_hooks() {
    echo "Merging Git LFS hooks with Husky hooks..."

    for hook in "${HOOKS[@]}"; do
        local hook_file="$HUSKY_TEMPLATES_DIR/$hook"

        # Skip if already configured
        if [ -f "$hook_file" ] && grep -q "=== BEGIN GIT LFS HOOK (added by fix-lfs-husky-hooks.sh) ===" "$hook_file"; then
            echo "✓ $hook: Already configured"
            continue
        fi

        # Generate LFS hook content
        local lfs_content
        lfs_content=$(generate_lfs_hook "$hook")

        if [ -f "$hook_file" ]; then
            # Merge with existing hook (LFS content before Husky initialization)
            {
                echo '#!/usr/bin/env sh'
                echo "$lfs_content"
                echo ""
                tail -n +2 "$hook_file"  # Skip shebang line
            } > "$hook_file.new" && mv "$hook_file.new" "$hook_file"
            echo "✓ $hook: Merged with existing hook"
        else
            # Create new hook
            {
                echo '#!/usr/bin/env sh'
                echo "$lfs_content"
                echo ""
                echo '. "$(dirname "$0")/h"'
            } > "$hook_file"
            echo "✓ $hook: Created new hook"
        fi

        chmod +x "$hook_file" || echo "⚠ Warning: Could not make $hook executable"
    done
}

# Main execution
main() {
    echo "Git LFS and Husky Integration Script"

    validate_environment

    if [ "$AUTO_MODE" = false ]; then
        read -p "This will modify Husky hooks to include Git LFS functionality. Continue? (y/N): " confirm
        [[ "$confirm" == [yY] ]] || exit 0
    fi

    backup_hooks
    merge_hooks

    echo "✅ Integration complete! You can now use Git LFS commands normally."
}

main
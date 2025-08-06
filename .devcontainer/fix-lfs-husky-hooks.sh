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
HUSKY_DIR=".husky/_"
BACKUP_DIR=".husky/_backups/$(date +%Y%m%d_%H%M%S)"
HOOKS=("pre-push" "post-checkout" "post-commit" "post-merge")
AUTO_MODE=false

# Process arguments
for arg in "$@"; do
    case "$arg" in
        --auto|--autoMergeLfsHusky)
            AUTO_MODE=true
            ;;
        --help|-h)
            echo "Usage: $0 [--auto|--autoMergeLfsHusky] [--help|-h]"
            echo ""
            echo "Options:"
            echo "  --auto, --autoMergeLfsHusky  Run in automatic mode without prompts"
            echo "  --help, -h                   Show this help message"
            exit 0
            ;;
    esac
done

# Check if Git LFS is configured in the repository
is_git_lfs_configured() {
    # Method 1: Check for .gitattributes with LFS filters
    if [ -f ".gitattributes" ] && grep -q "filter=lfs" ".gitattributes"; then
        return 0  # true in bash
    fi

    # Method 2: Check if any LFS pointers exist in the repo
    if git lfs ls-files 2>/dev/null | grep -q .; then
        return 0  # true
    fi

    # Method 3: Check Git config for LFS settings
    if git config --local --get-regexp "lfs" | grep -q .; then
        return 0  # true
    fi

    return 1  # false in bash
}

# Validate environment
validate_environment() {
    # Check if we're in a git repository
    if ! git rev-parse --is-inside-work-tree > /dev/null 2>&1; then
        echo "Error: Not in a git repository"
        exit 1
    fi

    # Check if Husky is configured
    if [ ! -d "$HUSKY_DIR" ]; then
        echo "Error: Husky directory '$HUSKY_DIR' not found"
        exit 1
    fi

    # Check if Git LFS is installed
    if ! command -v git-lfs > /dev/null 2>&1; then
        echo "Warning: Git LFS is not installed"
        if [ "$AUTO_MODE" = false ]; then
            read -p "Continue anyway? (y/N): " confirm
            [[ "$confirm" == [yY] ]] || exit 0
        fi
    fi

    # Check if Git LFS is actually configured in this repository
    if ! is_git_lfs_configured; then
        echo "Warning: Git LFS does not appear to be configured in this repository"
        if [ "$AUTO_MODE" = false ]; then
            read -p "Continue anyway? (y/N): " confirm
            [[ "$confirm" == [yY] ]] || exit 0
        else
            echo "Skipping hook modifications as Git LFS is not configured"
            exit 0
        fi
    fi
}

# Create backup of hooks
backup_hooks() {
    echo "Creating backup of hooks in $BACKUP_DIR"
    mkdir -p "$BACKUP_DIR"
    for hook in "${HOOKS[@]}"; do
        if [ -f "$HUSKY_DIR/$hook" ]; then
            cp "$HUSKY_DIR/$hook" "$BACKUP_DIR/$hook"
            echo "✓ Backed up $hook"
        fi
    done
}

# Generate Git LFS hook content for a specific hook
generate_lfs_hook() {
    local hook_type="$1"
    cat << EOF
command -v git-lfs >/dev/null 2>&1 || { printf >&2 "\n%s\n\n" "This repository is configured for Git LFS but 'git-lfs' was not found on your path. If you no longer wish to use Git LFS, remove this hook by deleting the '$hook_type' file in the hooks directory (set by 'core.hookspath'; usually '.git/hooks' but with husky it is '.husky/_')."; exit 2; }
git lfs $hook_type "\$@"
EOF
}

# Merge Git LFS hooks with Husky hooks
merge_hooks() {
    echo "Merging Git LFS hooks with Husky hooks..."

    for hook in "${HOOKS[@]}"; do
        # Generate Git LFS hook content
        LFS_HOOK=$(generate_lfs_hook "$hook")

        if [ -f "$HUSKY_DIR/$hook" ]; then
            # Check if hook already contains Git LFS content
            if grep -q "git lfs $hook" "$HUSKY_DIR/$hook"; then
                echo "✓ $hook: Already contains Git LFS hook"
                continue
            fi

            # Extract Husky header (first 2 lines typically)
            HUSKY_HEADER=$(head -n 2 "$HUSKY_DIR/$hook")

            # Extract existing content after header (preserving custom hook logic)
            EXISTING_CONTENT=$(tail -n +3 "$HUSKY_DIR/$hook")

            # Create merged hook with: header + LFS hook + existing content
            {
                echo "$HUSKY_HEADER"
                echo "$LFS_HOOK"
                # Only add existing content if it's not empty
                if [ -n "$EXISTING_CONTENT" ]; then
                    echo ""  # Add separator line
                    echo "# Original hook content"
                    echo "$EXISTING_CONTENT"
                fi
            } > "$HUSKY_DIR/$hook.new"

            # Verify the new file was created successfully
            if [ ! -s "$HUSKY_DIR/$hook.new" ]; then
                echo "⚠ Error creating new hook file for $hook"
                continue
            fi

            # Replace the original with the new version and make executable
            mv "$HUSKY_DIR/$hook.new" "$HUSKY_DIR/$hook"
            chmod +x "$HUSKY_DIR/$hook"
            echo "✓ $hook: Successfully merged"
        else
            echo "Creating new hook: $hook"
            # Create new hook with both Husky and Git LFS parts
            {
                echo '#!/usr/bin/env sh'
                echo '. "$(dirname "$0")/h"'
                echo "$LFS_HOOK"
            } > "$HUSKY_DIR/$hook"
            chmod +x "$HUSKY_DIR/$hook"
            echo "✓ $hook: Created"
        fi
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

    echo "✅ Git LFS and Husky integration complete!"
    echo "You can now use Git LFS commands normally."
}

main
#!/bin/bash
set -euo pipefail

#############################################
# CONFIGURE THESE VALUES
#############################################
NEW_NAME="mycompany"                        # lowercase, no spaces (used in IDs, config keys, package name)
NEW_DISPLAY_NAME="My Company AI Assistant"  # human-readable display name
NEW_DESCRIPTION="AI coding assistant"       # extension description
#############################################

OLD_NAME="yourcompany"
OLD_DISPLAY_NAME="Your Company AI Assistant"
OLD_DESCRIPTION="AI coding assistant powered by Azure OpenAI"

echo "=== Rebranding Extension ==="
echo "  Old: ${OLD_NAME} -> New: ${NEW_NAME}"
echo "  Display: ${OLD_DISPLAY_NAME} -> ${NEW_DISPLAY_NAME}"
echo ""

# 1. Rename all "yourcompany" references across the codebase
echo "[1/3] Replacing '${OLD_NAME}' -> '${NEW_NAME}' across source files..."

# Find all files containing the old name (exclude node_modules, .git, binaries)
grep -rl "${OLD_NAME}" \
    --include="*.ts" \
    --include="*.tsx" \
    --include="*.json" \
    --include="*.js" \
    --include="*.md" \
    --exclude-dir=node_modules \
    --exclude-dir=.git \
    --exclude-dir=out \
    --exclude-dir=dist \
    . | while read -r file; do
    # Replace all case variations
    sed -i "s/${OLD_NAME}/${NEW_NAME}/g" "$file"
    sed -i "s/${OLD_DISPLAY_NAME}/${NEW_DISPLAY_NAME}/g" "$file"
    echo "  Updated: $file"
done

# 2. Update package.json specific fields
echo ""
echo "[2/3] Updating package.json metadata..."

# Use node for reliable JSON manipulation
node -e "
const fs = require('fs');
const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8'));

pkg.name = '${NEW_NAME}-ai-assistant';
pkg.displayName = '${NEW_DISPLAY_NAME}';
pkg.description = '${NEW_DESCRIPTION}';
pkg.version = '1.0.0';
pkg.publisher = '${NEW_NAME}';

fs.writeFileSync('package.json', JSON.stringify(pkg, null, '\t') + '\n');
console.log('  name:', pkg.name);
console.log('  displayName:', pkg.displayName);
console.log('  version:', pkg.version);
console.log('  publisher:', pkg.publisher);
"

# 3. Update package-lock.json version + name
echo ""
echo "[3/3] Updating package-lock.json..."

node -e "
const fs = require('fs');
const lock = JSON.parse(fs.readFileSync('package-lock.json', 'utf8'));

lock.name = '${NEW_NAME}-ai-assistant';
lock.version = '1.0.0';
if (lock.packages && lock.packages['']) {
    lock.packages[''].name = '${NEW_NAME}-ai-assistant';
    lock.packages[''].version = '1.0.0';
}

fs.writeFileSync('package-lock.json', JSON.stringify(lock, null, '\t') + '\n');
console.log('  Done');
"

echo ""
echo "=== Rebranding Complete ==="
echo ""
echo "Verify with:"
echo "  grep -r '${OLD_NAME}' --include='*.ts' --include='*.tsx' --include='*.json' --exclude-dir=node_modules --exclude-dir=.git ."
echo ""
echo "Files changed:"
git diff --stat

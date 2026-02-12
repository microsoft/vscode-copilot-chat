#!/usr/bin/env bash
# =============================================================================
# Company Name Replacer Script
# =============================================================================
# This script replaces placeholder company branding throughout the extension.
#
# INSTRUCTIONS:
#   1. Edit the variables below to match your company name
#   2. Run: bash scripts/replace-company-name.sh
#   3. Verify the changes with: git diff
#   4. Revert if needed with: git checkout .
#
# The script is idempotent on the FIRST run. After that, running it again
# with different values requires reverting first (git checkout .).
# =============================================================================

set -euo pipefail

# ── Configure these ──────────────────────────────────────────────────────────
COMPANY_NAME="YourCompany"        # Display name, e.g. "MEAG", "Contoso"
COMPANY_LOWER="yourcompany"       # Lowercase for identifiers, e.g. "meag", "contoso"
COMPANY_UPPER="YOURCOMPANY"       # UPPERCASE for env vars, e.g. "MEAG", "CONTOSO"
# ─────────────────────────────────────────────────────────────────────────────

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"

echo "=== Company Name Replacer ==="
echo "  Display name : $COMPANY_NAME"
echo "  Lowercase    : $COMPANY_LOWER"
echo "  Uppercase    : $COMPANY_UPPER"
echo "  Repo root    : $REPO_ROOT"
echo ""

# Helper: sed in-place (works on both macOS and Linux)
sedi() {
	if [[ "$OSTYPE" == "darwin"* ]]; then
		sed -i '' "$@"
	else
		sed -i "$@"
	fi
}

# ─────────────────────────────────────────────────────────────────────────────
# 1. package.json — Branding & metadata
# ─────────────────────────────────────────────────────────────────────────────
echo "[1/7] Updating package.json ..."
PKG="$REPO_ROOT/package.json"

# Extension metadata
sedi "s/\"name\": \"yourcompany-ai-assistant\"/\"name\": \"${COMPANY_LOWER}-ai-assistant\"/" "$PKG"
sedi "s/\"displayName\": \"Your Company AI Assistant\"/\"displayName\": \"${COMPANY_NAME} AI Assistant\"/" "$PKG"
sedi "s/\"publisher\": \"yourcompany\"/\"publisher\": \"${COMPANY_LOWER}\"/" "$PKG"
sedi "s/\"version\": \"0.38.0\"/\"version\": \"1.0.0\"/" "$PKG"

# Chat participant full names & labels
sedi "s/\"fullName\": \"GitHub Copilot\"/\"fullName\": \"${COMPANY_NAME} Copilot\"/g" "$PKG"
sedi "s/\"label\": \"GitHub Copilot\"/\"label\": \"${COMPANY_NAME} Copilot\"/g" "$PKG"

# Command categories
sedi "s/\"category\": \"GitHub Copilot\"/\"category\": \"${COMPANY_NAME} Copilot\"/g" "$PKG"
sedi "s/\"category\": \"Your Company AI\"/\"category\": \"${COMPANY_NAME} AI\"/g" "$PKG"

# Configuration section title
sedi "s/\"title\": \"GitHub Copilot Chat\"/\"title\": \"${COMPANY_NAME} Copilot Chat\"/g" "$PKG"

# Settings keys and command IDs: yourcompany.ai.* and yourcompany.ado.*
sedi "s/yourcompany\.ai\./${COMPANY_LOWER}.ai./g" "$PKG"
sedi "s/yourcompany\.ado\./${COMPANY_LOWER}.ado./g" "$PKG"

# ─────────────────────────────────────────────────────────────────────────────
# 2. package.nls.json — User-visible strings
# ─────────────────────────────────────────────────────────────────────────────
echo "[2/7] Updating package.nls.json ..."
NLS="$REPO_ROOT/package.nls.json"
if [ -f "$NLS" ]; then
	sedi "s/GitHub Copilot Chat/${COMPANY_NAME} Copilot Chat/g" "$NLS"
	sedi "s/GitHub Copilot/${COMPANY_NAME} Copilot/g" "$NLS"
	sedi "s/Sign up for ${COMPANY_NAME} Copilot/Sign up for ${COMPANY_NAME} Copilot/g" "$NLS"
fi

# ─────────────────────────────────────────────────────────────────────────────
# 3. Source files — Output channel names & branding constants
# ─────────────────────────────────────────────────────────────────────────────
echo "[3/7] Updating output channel names and branding constants ..."

# Output channel name
sedi "s/= 'GitHub Copilot Chat'/= '${COMPANY_NAME} Copilot Chat'/" \
	"$REPO_ROOT/src/platform/log/vscode/outputChannelLogTarget.ts"

# Citations output channel name
sedi "s/= 'GitHub Copilot Log (Code References)'/= '${COMPANY_NAME} Copilot Log (Code References)'/" \
	"$REPO_ROOT/src/extension/completions-core/vscode-node/extension/src/codeReferencing/outputChannel.ts"

# Trajectory logger agent name
sedi "s/= 'GitHub Copilot Chat'/= '${COMPANY_NAME} Copilot Chat'/" \
	"$REPO_ROOT/src/platform/trajectory/node/trajectoryLoggerAdapter.ts"

# Extension ID
sedi "s/= 'GitHub\.copilot-chat'/= '${COMPANY_LOWER}.copilot-chat'/" \
	"$REPO_ROOT/src/extension/common/constants.ts"

# Diagnostic header
sedi "s/## GitHub Copilot Chat/## ${COMPANY_NAME} Copilot Chat/" \
	"$REPO_ROOT/src/extension/log/vscode-node/loggingActions.ts"

# Session login message
sedi "s/You are not signed in to GitHub\. Please sign in to use Copilot\./Authentication not configured. Please configure Azure AD credentials./" \
	"$REPO_ROOT/src/platform/authentication/vscode-node/session.ts"

# ─────────────────────────────────────────────────────────────────────────────
# 4. Source files — yourcompany.ai.* setting key references
# ─────────────────────────────────────────────────────────────────────────────
echo "[4/7] Updating yourcompany.ai.* and yourcompany.ado.* setting key references ..."

SOURCE_FILES=(
	"src/extension/byok/vscode-node/byokContribution.ts"
	"src/extension/byok/vscode-node/azureOnlyProvider.ts"
	"src/extension/completions/vscode-node/completionsCoreContribution.ts"
	"src/extension/inlineEdits/vscode-node/inlineEditProviderFeature.ts"
	"src/extension/extension/vscode-node/contributions.ts"
	"src/extension/tools/node/azureDevOps/azureDevOpsClient.ts"
	"src/extension/tools/node/azureDevOps/adoListWikisTool.ts"
	"src/extension/tools/node/azureDevOps/adoCreateWorkItemTool.ts"
	"src/extension/tools/node/azureDevOps/adoQueryWorkItemsTool.ts"
	"src/extension/tools/node/azureDevOps/adoUpdateWorkItemTool.ts"
	"src/extension/tools/node/azureDevOps/adoGetWikiPageTool.ts"
	"src/extension/tools/node/azureDevOps/adoGetWorkItemTool.ts"
	"src/extension/tools/node/azureDevOps/adoCreateOrUpdateWikiPageTool.ts"
	"src/extension/tools/node/azureDevOps/adoAddCommentTool.ts"
	"src/extension/tools/node/azureDevOps/adoGetWikiPageTreeTool.ts"
	"src/extension/completions-core/vscode-node/lib/src/networkConfiguration.ts"
	"src/platform/azure/common/azureEmbeddingsComputer.ts"
	"src/platform/azure/common/azureEndpointProvider.ts"
	"src/platform/azure/common/azureCopilotTokenManager.ts"
	"src/platform/azure/common/modelRouter.ts"
	"src/platform/azure/common/servicePrincipalAuth.ts"
	"src/platform/endpoint/node/proxyXtabEndpoint.ts"
)

for f in "${SOURCE_FILES[@]}"; do
	filepath="$REPO_ROOT/$f"
	if [ -f "$filepath" ]; then
		sedi "s/yourcompany\.ai\./${COMPANY_LOWER}.ai./g" "$filepath"
		sedi "s/yourcompany\.ado\./${COMPANY_LOWER}.ado./g" "$filepath"
	else
		echo "  WARNING: File not found: $f"
	fi
done

# ─────────────────────────────────────────────────────────────────────────────
# 5. Environment variable name
# ─────────────────────────────────────────────────────────────────────────────
echo "[5/7] Updating environment variable names ..."
sedi "s/YOURCOMPANY_AI_CLIENT_SECRET/${COMPANY_UPPER}_AI_CLIENT_SECRET/g" \
	"$REPO_ROOT/src/platform/azure/common/servicePrincipalAuth.ts"

# ─────────────────────────────────────────────────────────────────────────────
# 6. Error messages referencing company name
# ─────────────────────────────────────────────────────────────────────────────
echo "[6/7] Updating error messages with company references ..."
sedi "s/Set yourcompany\./Set ${COMPANY_LOWER}./g" \
	"$REPO_ROOT/src/platform/azure/common/servicePrincipalAuth.ts"

for f in "${SOURCE_FILES[@]}"; do
	filepath="$REPO_ROOT/$f"
	if [ -f "$filepath" ]; then
		sedi "s/Set yourcompany\./Set ${COMPANY_LOWER}./g" "$filepath"
	fi
done

# ─────────────────────────────────────────────────────────────────────────────
# 7. Verify
# ─────────────────────────────────────────────────────────────────────────────
echo "[7/7] Verifying ..."
REMAINING=$(grep -r "yourcompany" "$REPO_ROOT/src/" "$REPO_ROOT/package.json" "$REPO_ROOT/package.nls.json" 2>/dev/null | grep -v node_modules | grep -v ".git/" | grep -v "test/" || true)
if [ -n "$REMAINING" ]; then
	echo ""
	echo "WARNING: Some 'yourcompany' references remain (may be in test files or comments):"
	echo "$REMAINING"
else
	echo "  All 'yourcompany' references in src/ and package files have been replaced."
fi

REMAINING_UPPER=$(grep -r "YOURCOMPANY" "$REPO_ROOT/src/" 2>/dev/null | grep -v node_modules | grep -v ".git/" | grep -v "test/" || true)
if [ -n "$REMAINING_UPPER" ]; then
	echo ""
	echo "WARNING: Some 'YOURCOMPANY' references remain:"
	echo "$REMAINING_UPPER"
fi

REMAINING_GH=$(grep -rn "\"GitHub Copilot\"" "$REPO_ROOT/package.json" "$REPO_ROOT/package.nls.json" 2>/dev/null || true)
if [ -n "$REMAINING_GH" ]; then
	echo ""
	echo "NOTE: Some 'GitHub Copilot' references remain in package files (may be in locked strings or comments):"
	echo "$REMAINING_GH"
fi

echo ""
echo "=== Done! ==="
echo "Review changes with: git diff"
echo "Revert with: git checkout ."

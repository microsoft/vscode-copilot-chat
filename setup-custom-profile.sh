#!/bin/bash

# Custom Copilot Profile Setup Script
# This script creates a VS Code profile specifically for testing the custom Copilot extension

echo "🚀 Setting up Custom Copilot Profile..."

# Set environment variables for custom authentication
export USE_CUSTOM_AUTH=true
export CUSTOM_COPILOT_API_KEY="test-api-key-12345"
export CUSTOM_COPILOT_ENDPOINT="https://test-auth.example.com/token"
export CUSTOM_ORG_PROVIDER="CustomOrg"

echo "✅ Environment variables set:"
echo "   USE_CUSTOM_AUTH=$USE_CUSTOM_AUTH"
echo "   CUSTOM_COPILOT_API_KEY=$CUSTOM_COPILOT_API_KEY"
echo "   CUSTOM_COPILOT_ENDPOINT=$CUSTOM_COPILOT_ENDPOINT"
echo "   CUSTOM_ORG_PROVIDER=$CUSTOM_ORG_PROVIDER"

# Build the extension first
echo "🔨 Building extension..."
npm run compile

# Open VS Code with the custom profile
echo "🎯 Opening VS Code with Custom Copilot Profile..."
code --profile "Custom Copilot Auth" --new-window . &

echo ""
echo "🎉 Custom Copilot Profile Setup Complete!"
echo ""
echo "📝 Next Steps:"
echo "1. The new VS Code window should open with the 'Custom Copilot Auth' profile"
echo "2. Press F5 to launch the extension in debug mode with custom authentication"
echo "3. Or use the 'Launch Custom Auth Copilot Extension' debug configuration"
echo "4. Test that Copilot features work without authentication prompts"
echo ""
echo "💡 Tips:"
echo "- Check the Debug Console for custom authentication logs"
echo "- The extension will always behave as fully authenticated"
echo "- All Copilot features should be available immediately"
echo "- No GitHub login or minimal mode restrictions"

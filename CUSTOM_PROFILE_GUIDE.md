# Custom Copilot Profile Usage Guide

## 🎯 Overview
This guide explains how to use the custom VS Code profile optimized for testing the GitHub Copilot Chat extension with custom authentication.

## 🚀 Quick Start

### Option 1: Using the Setup Script
```bash
./setup-custom-profile.sh
```
This will build the extension and open VS Code with the custom profile.

### Option 2: Manual Launch
```bash
# Set environment variables
export USE_CUSTOM_AUTH=true
export CUSTOM_COPILOT_API_KEY="test-api-key-12345"
export CUSTOM_COPILOT_ENDPOINT="https://test-auth.example.com/token"
export CUSTOM_ORG_PROVIDER="CustomOrg"

# Open VS Code with custom profile
code --profile "Custom Copilot Auth" --new-window .
```

### Option 3: Debug Launch Configuration
1. Open VS Code in the project
2. Go to Run and Debug (Ctrl+Shift+D)
3. Select "Launch Custom Auth Copilot Extension"
4. Press F5 to start debugging

## 🔧 Profile Features

### ✅ What's Enabled
- **Custom Authentication**: Always authenticated, no login required
- **Full Copilot Features**: All chat participants, inline editing, completions
- **Business Plan Simulation**: Enterprise features enabled
- **Debug Logging**: Enhanced logging for development
- **Optimized Settings**: Tailored for extension development

### ✅ What's Disabled
- **Auto-updates**: Extensions won't auto-update during testing
- **Recommendations**: No extension recommendation popups
- **Preview Mode**: Files open directly in editor tabs

## 🧪 Testing the Custom Authentication

### 1. Verify Authentication Status
- Open the Command Palette (Cmd+Shift+P)
- Run "Developer: Reload Window"
- Check that no GitHub login prompts appear
- Copilot should be immediately available

### 2. Test Chat Features
- Open Copilot Chat (Ctrl+Alt+I or click the chat icon)
- Try different participants: `@workspace`, `@terminal`, etc.
- All features should work without authentication barriers

### 3. Test Inline Features
- Press Ctrl+I in any file to trigger inline chat
- Try code completions and suggestions
- All should work seamlessly

### 4. Check Debug Console
- Open Debug Console in the Extension Development Host
- Look for custom authentication logs:
  ```
  [CustomAuthenticationService] Always authenticated
  [CustomCopilotTokenManager] Providing custom token
  ```

## 🔍 Troubleshooting

### Extension Not Loading
```bash
# Rebuild and restart
npm run compile
code --profile "Custom Copilot Auth" --new-window .
```

### Authentication Issues
1. Check environment variables are set:
   ```bash
   echo $USE_CUSTOM_AUTH
   echo $CUSTOM_COPILOT_API_KEY
   ```
2. Verify custom services are registered in `services.ts`
3. Check Debug Console for error messages

### Profile Not Found
If VS Code says the profile doesn't exist:
```bash
# Create the profile first
code --profile "Custom Copilot Auth" --new-window
# Then close and reopen with the project
code --profile "Custom Copilot Auth" --new-window .
```

## 📝 Environment Variables

| Variable | Purpose | Example Value |
|----------|---------|---------------|
| `USE_CUSTOM_AUTH` | Enable custom authentication | `true` |
| `CUSTOM_COPILOT_API_KEY` | API key for requests | `test-api-key-12345` |
| `CUSTOM_COPILOT_ENDPOINT` | Custom endpoint URL | `https://test-auth.example.com/token` |
| `CUSTOM_ORG_PROVIDER` | Organization name | `CustomOrg` |
| `COPILOT_LOG_TELEMETRY` | Enable telemetry logging | `true` |
| `VSCODE_DEV_DEBUG` | Enable debug mode | `1` |

## 🎯 Testing Checklist

- [ ] Extension loads without errors
- [ ] No GitHub authentication prompts
- [ ] Copilot chat opens and responds
- [ ] Inline chat (Ctrl+I) works
- [ ] Code completions appear
- [ ] All chat participants available (@workspace, @terminal, etc.)
- [ ] Debug console shows custom auth messages
- [ ] No "minimal mode" or feature restrictions

## 🔄 Profile Management

### Switch Between Profiles
```bash
# Default profile
code .

# Custom Copilot profile
code --profile "Custom Copilot Auth" .
```

### Reset Profile
If you need to reset the custom profile:
1. Close all VS Code windows
2. Delete the profile: `rm -rf ~/Library/Application\ Support/Code/User/profiles/Custom\ Copilot\ Auth`
3. Run the setup script again

## 📚 Additional Resources

- [VS Code Profiles Documentation](https://code.visualstudio.com/docs/editor/profiles)
- [Extension Development Guide](./CONTRIBUTING.md)
- [Custom Authentication Implementation](./src/platform/authentication/custom/README.md)
- [Integration Guide](./CUSTOM_AUTH_INTEGRATION.md)

---

🎉 **Happy Testing!** Your custom authentication profile is ready to provide a seamless Copilot experience.

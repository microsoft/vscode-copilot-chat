# Custom Authentication for GitHub Copilot Chat

This directory contains custom authentication implementations that behave as if the user is **fully authenticated** with access to **all GitHub Copilot features**.

## 🎯 Purpose

These custom services simulate a perfect authentication state where:

- ✅ User is always authenticated
- ✅ Full permissive GitHub access (read:user, user:email, repo, workflow scopes)
- ✅ Business plan Copilot subscription
- ✅ VS Code team member benefits
- ✅ Azure DevOps integration
- ✅ Long-lived tokens (1 year expiration)
- ✅ Automatic token refresh on errors

## 📁 Files

### `customAuthenticationService.ts`
Custom authentication service that:
- Always returns valid GitHub sessions
- Provides both basic and permissive access
- Includes Azure DevOps authentication
- Never triggers minimal mode restrictions

### `customCopilotTokenManager.ts`
Custom token manager that:
- Always provides valid Copilot tokens
- Simulates business plan subscription
- Grants VS Code team member benefits
- Auto-refreshes tokens instead of failing

### `customAuthServices.ts`
Service registration utilities:
- `registerCustomAuthenticationServices()` - Registers the custom services
- `getCustomAuthConfig()` - Gets configuration from environment/settings
- `CustomAuthConfig` - Configuration interface

### `index.ts`
Main exports for the custom authentication module.

## 🚀 Usage

### Option 1: Environment Variables

Set these environment variables:
```bash
export CUSTOM_COPILOT_API_KEY="your-custom-api-key"
export CUSTOM_COPILOT_ENDPOINT="https://your-auth-endpoint.com/token"
export CUSTOM_ORG_PROVIDER="YourCompany"
```

### Option 2: Direct Integration

Modify `src/extension/extension/vscode-node/services.ts`:

```typescript
import { registerCustomAuthenticationServices, getCustomAuthConfig } from '../../../platform/authentication/custom';

export function registerServices(builder: IInstantiationServiceBuilder, extensionContext: ExtensionContext): void {
    // Register common services first
    registerCommonServices(builder, extensionContext);

    // Check for custom authentication configuration
    const customConfig = getCustomAuthConfig();
    if (customConfig) {
        // Use custom authentication with full access
        registerCustomAuthenticationServices(builder, extensionContext, customConfig);
    } else {
        // Use default authentication services
        if (isTestMode) {
            builder.define(ICopilotTokenManager, getOrCreateTestingCopilotTokenManager());
        } else {
            builder.define(ICopilotTokenManager, new SyncDescriptor(VSCodeCopilotTokenManager));
        }
        builder.define(IAuthenticationService, new SyncDescriptor(AuthenticationService));
    }

    // Register other services...
}
```

### Option 3: Always Use Custom Auth

Replace the default service registrations:

```typescript
// Replace these lines:
// builder.define(ICopilotTokenManager, new SyncDescriptor(VSCodeCopilotTokenManager));
// builder.define(IAuthenticationService, new SyncDescriptor(AuthenticationService));

// With custom services:
import { CustomCopilotTokenManager, CustomAuthenticationService } from '../../../platform/authentication/custom';

builder.define(ICopilotTokenManager, new SyncDescriptor(CustomCopilotTokenManager, [
    'your-api-key',
    'https://your-endpoint.com'
]));

builder.define(IAuthenticationService, new SyncDescriptor(CustomAuthenticationService, [
    'YourCompany'
]));
```

## 🔧 Configuration

The custom authentication accepts these configuration options:

| Parameter | Description | Default |
|-----------|-------------|---------|
| `apiKey` | Custom API key for your auth system | Required |
| `endpoint` | Token acquisition endpoint URL | Required |
| `orgProvider` | Organization name for display | `"CustomOrg"` |

## 🏆 Features Enabled

With this custom authentication, all GitHub Copilot features are fully enabled:

### Chat & Conversation
- ✅ All chat participants (@workspace, @vscode, etc.)
- ✅ Inline chat (`Ctrl+I`)
- ✅ Agent mode for multi-step tasks
- ✅ Code explanations and documentation
- ✅ Code generation and refactoring

### Advanced Features
- ✅ Workspace semantic search
- ✅ Related files discovery
- ✅ GitHub repository integration
- ✅ Pull request and issue access
- ✅ Azure DevOps integration
- ✅ Test generation
- ✅ Debug assistance

### Code Intelligence
- ✅ Inline completions
- ✅ Code suggestions
- ✅ Rename suggestions
- ✅ Fix suggestions
- ✅ Code reviews

### Enterprise Features
- ✅ Business plan features
- ✅ VS Code team member benefits
- ✅ Advanced telemetry (if configured)
- ✅ Organization policies bypass

## 🔒 Security Notes

This implementation is designed for:
- Development and testing environments
- Corporate environments with custom auth systems
- Scenarios where you need guaranteed authentication

**Important**: These services bypass normal authentication flows. Ensure you understand the security implications for your use case.

## 🛠️ Development

To modify the custom authentication:

1. Edit the service implementations in this directory
2. Run `npm run compile` to build
3. Test with Extension Development Host
4. Run tests: `npm run test:unit`

## 🐛 Troubleshooting

### Common Issues

**Authentication not working:**
- Check that custom services are properly registered
- Verify environment variables are set
- Check VS Code Developer Console for errors

**Features still restricted:**
- Ensure `isMinimalMode` returns `false`
- Verify permissive session has correct scopes
- Check token expiration times

**Token errors:**
- Custom tokens are auto-refreshed, but check endpoint availability
- Verify token format matches expectations
- Check network connectivity to custom endpoints

### Debug Logging

Enable debug logging to see authentication flow:
```typescript
// In VS Code settings.json
{
    "copilot.debug": true,
    "copilot.advanced": {
        "debug.testOverride": {
            "logging": "debug"
        }
    }
}
```

## 📚 Architecture

The custom authentication integrates with the existing dependency injection system:

```
Extension Startup
    ↓
registerServices()
    ↓
Custom Service Registration
    ↓
Dependency Injection
    ↓
All Extension Features Use Custom Auth
    ↓
Perfect Authentication State
```

This ensures that every component in the extension receives the custom authentication services and behaves as if the user has full access to all features.

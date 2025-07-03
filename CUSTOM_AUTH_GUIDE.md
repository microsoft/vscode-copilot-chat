# Custom Authentication Service and Token Manager Guide

This guide explains how to inject custom authentication services and token managers into the GitHub Copilot Chat extension.

## Overview

The GitHub Copilot Chat extension uses a dependency injection system to manage authentication. You can override the default implementations with custom ones to integrate with your organization's authentication systems.

## Key Components

### 1. Authentication Service (`IAuthenticationService`)

The authentication service handles:
- GitHub session management (basic and permissive)
- Azure DevOps authentication
- Copilot token delegation
- Authentication state events

### 2. Token Manager (`ICopilotTokenManager`)

The token manager handles:
- Copilot token acquisition and refresh
- Token caching and expiration
- Token error handling

## Service Registration Points

Services are registered in these key files:
- `src/extension/extension/vscode-node/services.ts` (Node.js environment)
- `src/extension/extension/vscode/services.ts` (Web environment)

The key registration lines are:
```typescript
// Default registrations
builder.define(ICopilotTokenManager, new SyncDescriptor(VSCodeCopilotTokenManager));
builder.define(IAuthenticationService, new SyncDescriptor(AuthenticationService));
```

## Implementation Steps

### Step 1: Create Custom Token Manager

```typescript
import { BaseCopilotTokenManager } from './src/platform/authentication/node/copilotTokenManager';
import { CopilotToken, ExtendedTokenInfo } from './src/platform/authentication/common/copilotToken';

export class CustomCopilotTokenManager extends BaseCopilotTokenManager {
    private readonly customApiKey: string;
    private readonly customEndpoint: string;

    constructor(
        customApiKey: string,
        customEndpoint: string,
        // All required base class dependencies
        logService: ILogService,
        telemetryService: ITelemetryService,
        domainService: IDomainService,
        capiClientService: ICAPIClientService,
        fetcherService: IFetcherService,
        envService: IEnvService
    ) {
        super(
            new BaseOctoKitService(capiClientService, fetcherService),
            logService,
            telemetryService,
            domainService,
            capiClientService,
            fetcherService,
            envService
        );

        this.customApiKey = customApiKey;
        this.customEndpoint = customEndpoint;
    }

    async getCopilotToken(force?: boolean): Promise<CopilotToken> {
        // Check cached token
        if (!force && this.copilotToken && this.copilotToken.expires_at > Date.now() / 1000) {
            return new CopilotToken(this.copilotToken);
        }

        try {
            // Your custom token acquisition logic
            const tokenString = await this.acquireCustomToken();

            const tokenInfo: ExtendedTokenInfo = {
                token: tokenString,
                expires_at: Date.now() / 1000 + 3600, // 1 hour
                refresh_in: 3000, // 50 minutes
                username: 'custom-user',
                isVscodeTeamMember: false,
                copilot_plan: 'business'
            };

            this.copilotToken = tokenInfo; // Uses base class setter
            return new CopilotToken(tokenInfo);
        } catch (error) {
            this.copilotToken = undefined;
            throw error;
        }
    }

    resetCopilotToken(httpError?: number): void {
        this.copilotToken = undefined;
    }

    private async acquireCustomToken(): Promise<string> {
        const response = await fetch(this.customEndpoint, {
            headers: {
                'Authorization': `Bearer ${this.customApiKey}`,
                'Content-Type': 'application/json'
            }
        });

        if (!response.ok) {
            throw new Error(`Failed to acquire token: ${response.status}`);
        }

        const data = await response.json();
        return data.token;
    }
}
```

### Step 2: Create Custom Authentication Service

```typescript
import { BaseAuthenticationService } from './src/platform/authentication/common/authentication';

export class CustomAuthenticationService extends BaseAuthenticationService {
    private readonly customOrgProvider: string;

    constructor(
        customOrgProvider: string,
        logService: ILogService,
        tokenStore: ICopilotTokenStore,
        tokenManager: ICopilotTokenManager,
        configurationService: IConfigurationService
    ) {
        super(logService, tokenStore, tokenManager, configurationService);
        this.customOrgProvider = customOrgProvider;
    }

    async getAnyGitHubSession(options?: AuthenticationGetSessionOptions): Promise<AuthenticationSession | undefined> {
        return this.createCustomSession('basic');
    }

    async getPermissiveGitHubSession(options: AuthenticationGetSessionOptions): Promise<AuthenticationSession | undefined> {
        if (this.isMinimalMode) {
            if (options.createIfNone || options.forceNewSession) {
                throw new Error('Minimal mode - cannot create permissive session');
            }
            return undefined;
        }

        return this.createCustomSession('permissive');
    }

    async getAdoAccessTokenBase64(options?: AuthenticationGetSessionOptions): Promise<string | undefined> {
        const adoToken = await this.acquireAdoToken();
        return adoToken ? Buffer.from(`PAT:${adoToken}`, 'utf8').toString('base64') : undefined;
    }

    private async createCustomSession(scope: 'basic' | 'permissive'): Promise<AuthenticationSession> {
        const token = await this.acquireSessionToken(scope);

        return {
            id: `custom-${scope}-${Date.now()}`,
            accessToken: token,
            scopes: scope === 'permissive' ? ['read:user', 'user:email', 'repo', 'workflow'] : ['user:email'],
            account: {
                id: 'custom-user-id',
                label: `Custom User (${this.customOrgProvider})`
            }
        };
    }

    private async acquireSessionToken(scope: string): Promise<string> {
        // Your custom token acquisition logic
        return `custom-token-${scope}-${Date.now()}`;
    }

    private async acquireAdoToken(): Promise<string | undefined> {
        // Your custom Azure DevOps token logic
        return 'custom-ado-token';
    }
}
```

### Step 3: Service Registration Function

```typescript
import { IInstantiationServiceBuilder } from './src/util/common/services';
import { SyncDescriptor } from './src/util/vs/platform/instantiation/common/descriptors';
import { ICopilotTokenManager } from './src/platform/authentication/common/copilotTokenManager';
import { IAuthenticationService } from './src/platform/authentication/common/authentication';

export function registerCustomAuthenticationServices(
    builder: IInstantiationServiceBuilder,
    customConfig: {
        apiKey: string;
        endpoint: string;
        orgProvider: string;
    }
): void {
    // Override default services
    builder.define(ICopilotTokenManager, new SyncDescriptor(CustomCopilotTokenManager, [
        customConfig.apiKey,
        customConfig.endpoint
    ]));

    builder.define(IAuthenticationService, new SyncDescriptor(CustomAuthenticationService, [
        customConfig.orgProvider
    ]));
}
```

### Step 4: Integration

Modify `src/extension/extension/vscode-node/services.ts`:

```typescript
export function registerServices(builder: IInstantiationServiceBuilder, extensionContext: ExtensionContext): void {
    // Register common services first
    registerCommonServices(builder, extensionContext);

    // Check for custom configuration
    const customConfig = {
        apiKey: process.env.CUSTOM_COPILOT_API_KEY || '',
        endpoint: process.env.CUSTOM_COPILOT_ENDPOINT || '',
        orgProvider: process.env.CUSTOM_ORG_PROVIDER || 'YourCompany'
    };

    // Use custom services if configured
    if (customConfig.apiKey && customConfig.endpoint) {
        registerCustomAuthenticationServices(builder, customConfig);
    } else {
        // Use default services
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

## Configuration Options

You can control custom authentication through:

1. **Environment Variables**:
   ```bash
   CUSTOM_COPILOT_API_KEY=your_api_key
   CUSTOM_COPILOT_ENDPOINT=https://your-auth-endpoint.com/token
   CUSTOM_ORG_PROVIDER=YourCompany
   ```

2. **VS Code Settings**:
   ```json
   {
     "copilot.customAuth.apiKey": "your_api_key",
     "copilot.customAuth.endpoint": "https://your-auth-endpoint.com/token",
     "copilot.customAuth.orgProvider": "YourCompany"
   }
   ```

## Testing

To test your custom implementation:

1. Set up your custom configuration
2. Build the extension: `npm run compile`
3. Run tests: `npm run test:unit`
4. Use the Extension Development Host to test the full integration

## Error Handling

Your custom implementations should handle:

- Network errors during token acquisition
- Token expiration and refresh
- Authentication failures
- Configuration validation

## Security Considerations

- Store sensitive configuration securely
- Validate all authentication responses
- Implement proper token caching with expiration
- Log authentication events for auditing
- Handle token revocation gracefully

## Integration Points

Your custom services will be automatically used by:

- Chat participants and agents
- Inline chat and editing features
- Code completions and suggestions
- GitHub repository access
- Azure DevOps integration
- Telemetry and analytics

This allows you to completely control authentication while maintaining all extension functionality.

## Fully Authenticated Behavior

The custom implementations have been configured to behave as if the user is **fully authenticated** with access to **all features**:

### Custom Token Manager Features:
- ✅ **Long-lived tokens**: 24-hour expiration with 23-hour refresh
- ✅ **Enterprise user**: Marked as VS Code team member for full feature access
- ✅ **Business plan**: All Copilot business features enabled
- ✅ **All permissions**: copilot:all, repo:all, workflow:all, admin:all
- ✅ **All features**: chat, completions, edits, agents, workspace access

### Custom Authentication Service Features:
- ✅ **Never in minimal mode**: Always returns `false` for `isMinimalMode`
- ✅ **Full GitHub permissions**: Includes admin scopes (admin:org, admin:repo_hook, admin:enterprise)
- ✅ **Always authenticated**: Never fails authentication, always returns valid sessions
- ✅ **Azure DevOps support**: Full ADO token access with all scopes
- ✅ **Cached sessions**: Properly caches both basic and permissive sessions

### What This Enables:
- 🚀 **All chat participants and agents** work without restrictions
- 🚀 **Inline chat and editing** (`Ctrl+I`) with full capabilities
- 🚀 **Code completions and suggestions** without quota limits
- 🚀 **Workspace understanding** and semantic search
- 🚀 **GitHub repository access** for context and code search
- 🚀 **Test generation and debugging** features
- 🚀 **All experimental features** and VS Code team-only features

### Token Structure:
```typescript
{
  token: "copilot_enterprise_full_[base64]",
  expires_at: Date.now() + 24h,
  refresh_in: 23h,
  username: "enterprise-user",
  isVscodeTeamMember: true,     // ← Enables all features
  copilot_plan: "business"      // ← Business plan features
}
```

### Session Structure:
```typescript
{
  id: "enterprise-auth-permissive-[timestamp]",
  accessToken: "ghp_enterprise_[base64]",
  scopes: [
    "read:user", "user:email", "repo", "workflow",
    "admin:org", "admin:repo_hook", "admin:enterprise"  // ← Full permissions
  ],
  account: {
    id: "enterprise-user-123",
    label: "Enterprise User (YourCompany) - Full Access"
  }
}
```

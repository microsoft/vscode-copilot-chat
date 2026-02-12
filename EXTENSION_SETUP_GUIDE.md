# Extension Setup Guide

This guide walks you through installing and configuring the **Your Company AI Assistant** VS Code extension from a `.vsix` file.

## Prerequisites

- **VS Code** version `1.109.0` or newer
- An **Azure OpenAI** resource with at least one model deployed
- An **Azure AD app registration** (service principal) with access to your Azure OpenAI resource

## Step 1: Install the .vsix File

### Option A: From the VS Code UI

1. Open VS Code
2. Open the Command Palette (`Ctrl+Shift+P` / `Cmd+Shift+P`)
3. Type **"Extensions: Install from VSIX..."** and select the command
4. Browse to and select the `.vsix` file
5. Wait for the installation to complete and reload VS Code when prompted

### Option B: From the command line

```bash
code --install-extension yourcompany-ai-assistant-0.38.0.vsix
```

Replace the filename with the actual `.vsix` file you have.

### Option C: Drag and drop

Drag the `.vsix` file directly into the Extensions view sidebar in VS Code.

> **Note:** After installation, VS Code may need to reload. Click "Reload Now" if prompted, or run **Developer: Reload Window** from the Command Palette.

## Step 2: Disable the Marketplace Copilot Extensions (if installed)

This extension replaces the standard GitHub Copilot Chat extension. If you have either of these installed, **disable or uninstall them** to avoid conflicts:

- `GitHub.copilot`
- `GitHub.copilot-chat`

To do this: open the Extensions sidebar (`Ctrl+Shift+X`), find each extension, and click **Disable** or **Uninstall**.

## Step 3: Configure Azure OpenAI Connection

Open your VS Code settings (`Ctrl+,` / `Cmd+,`) and search for `yourcompany.ai` to find all the relevant settings. You can also edit `settings.json` directly.

### Required Settings

Add the following to your `settings.json` (User or Workspace level):

```jsonc
{
    // Azure AD tenant ID for service principal authentication
    "yourcompany.ai.tenantId": "<your-azure-ad-tenant-id>",

    // Service principal client ID (from your app registration)
    "yourcompany.ai.clientId": "<your-app-registration-client-id>",

    // Azure OpenAI endpoint URL
    "yourcompany.ai.endpoint": "https://<your-resource-name>.openai.azure.com",

    // Map of deployment names to model configurations
    "yourcompany.ai.deployments": {
        "gpt-4o": {
            "name": "GPT-4o",
            "maxInputTokens": 128000,
            "maxOutputTokens": 16384,
            "toolCalling": true,
            "vision": true,
            "thinking": false,
            "apiVersion": "2024-12-01-preview"
        }
    }
}
```

### Set the Client Secret

The client secret is stored securely in VS Code's secret storage (not in `settings.json`).

1. Open the Command Palette (`Ctrl+Shift+P` / `Cmd+Shift+P`)
2. Run **"Your Company AI: Update Client Secret"**
3. Enter the client secret from your Azure AD app registration
4. Reload VS Code when prompted

### Deployment Configuration Properties

Each entry in `yourcompany.ai.deployments` supports the following properties:

| Property | Type | Default | Description |
|---|---|---|---|
| `name` | string | — | Display name shown in the model picker |
| `maxInputTokens` | number | `128000` | Maximum input token limit |
| `maxOutputTokens` | number | `16384` | Maximum output token limit |
| `toolCalling` | boolean | `true` | Whether the model supports tool/function calling |
| `vision` | boolean | `false` | Whether the model supports image input |
| `thinking` | boolean | `false` | Whether the model supports extended thinking/reasoning |
| `apiVersion` | string | `"2024-12-01-preview"` | Azure OpenAI API version to use |

### Example: Multiple Deployments

```jsonc
{
    "yourcompany.ai.deployments": {
        "gpt-4o": {
            "name": "GPT-4o",
            "maxInputTokens": 128000,
            "maxOutputTokens": 16384,
            "toolCalling": true,
            "vision": true
        },
        "gpt-4o-mini": {
            "name": "GPT-4o Mini",
            "maxInputTokens": 128000,
            "maxOutputTokens": 16384,
            "toolCalling": true,
            "vision": false
        },
        "o1": {
            "name": "o1",
            "maxInputTokens": 200000,
            "maxOutputTokens": 100000,
            "toolCalling": false,
            "thinking": true
        }
    }
}
```

## Step 4: Configure Routing (Optional)

You can route different features to specific deployments:

```jsonc
{
    "yourcompany.ai.routing": {
        "chat": "gpt-4o",           // Chat conversations
        "completions": "gpt-4o-mini", // Inline code completions
        "embeddings": "text-embedding-3-large", // Semantic search
        "code-apply": "gpt-4o-mini", // Code diff application
        "intent-detection": "gpt-4o-mini" // Intent classification
    }
}
```

If not configured, the extension uses the first available deployment for all features.

## Step 5: Configure Embeddings (Optional)

If you have an embeddings model deployed for semantic search:

```jsonc
{
    "yourcompany.ai.embeddingsDeployment": "text-embedding-3-large",
    "yourcompany.ai.embeddingsApiVersion": "2024-12-01-preview"
}
```

## Step 6: Configure Azure DevOps Integration (Optional)

If your team uses Azure DevOps:

```jsonc
{
    "yourcompany.ado.orgUrl": "https://dev.azure.com/your-org",
    "yourcompany.ado.pat": "<your-personal-access-token>",
    "yourcompany.ado.defaultProject": "MyProject"
}
```

## Step 7: Verify It Works

1. **Reload VS Code** (`Ctrl+Shift+P` > "Developer: Reload Window")
2. **Open the Chat panel** using the chat icon in the sidebar or `Ctrl+Alt+I` / `Cmd+Alt+I`
3. Type a message such as `Hello, are you working?` and press Enter
4. You should see a response from the AI assistant

If you see an error, check the **Output** panel (`Ctrl+Shift+U`) and select the extension's output channel from the dropdown to see detailed logs.

## Additional Settings

### Custom Instructions

Inject custom instructions into all AI prompts:

```jsonc
{
    // Single instruction
    "yourcompany.ai.customInstructions": "Always respond in English. Use concise answers.",

    // Or an array of instructions
    "yourcompany.ai.customInstructions": [
        "Follow our team coding standards.",
        "Prefer functional programming patterns.",
        "Include error handling in all code suggestions."
    ]
}
```

### Copilot Feature Toggles

These settings control which features are active:

| Setting | Default | Description |
|---|---|---|
| `github.copilot.chat.claudeAgent.enabled` | `true` | Enable the Claude agent session type |
| `github.copilot.chat.backgroundAgent.enabled` | `true` | Enable the Background agent for long-running tasks |
| `github.copilot.chat.cloudAgent.enabled` | `true` | Enable the Cloud agent |
| `github.copilot.editor.enableCodeActions` | `true` | Show AI code actions in the editor |
| `github.copilot.renameSuggestions.triggerAutomatically` | `true` | Suggest AI-powered rename alternatives |
| `github.copilot.chat.codeGeneration.useInstructionFiles` | `true` | Use `.github/copilot-instructions.md` for code generation |
| `github.copilot.nextEditSuggestions.enabled` | `false` | Enable next edit suggestions (experimental) |
| `github.copilot.chat.localeOverride` | `"auto"` | Override response language (e.g., `"en"`, `"fr"`, `"de"`) |

### Enable/Disable Completions per Language

Control which file types get inline completion suggestions:

```jsonc
{
    "github.copilot.enable": {
        "*": true,
        "plaintext": false,
        "markdown": false,
        "scminput": false
    }
}
```

## Troubleshooting

### Extension does not activate

- Verify your VS Code version is `1.109.0` or newer (**Help > About**)
- Check for conflicting extensions (disable `GitHub.copilot` and `GitHub.copilot-chat` from the Marketplace)
- Open the **Output** panel and look for error messages in the extension's output channel

### Authentication fails

- Confirm `yourcompany.ai.tenantId` and `yourcompany.ai.clientId` are correct
- Re-run the **"Your Company AI: Update Client Secret"** command to reset the secret
- Ensure the service principal has the proper role assignment on your Azure OpenAI resource
- Reload VS Code after updating credentials

### No model responses

- Verify `yourcompany.ai.endpoint` is the correct Azure OpenAI endpoint URL
- Confirm at least one deployment is configured in `yourcompany.ai.deployments`
- Check that the deployment name in settings exactly matches the deployment name in Azure
- Look at the Output panel for HTTP error codes (e.g., 401 = auth issue, 404 = wrong deployment name)

### Inline completions not working

- Check that `github.copilot.enable` includes `"*": true` or your specific language
- Ensure a deployment with `toolCalling` support is available
- Try manually triggering completions with `Alt+\`

### Chat says "no model available"

- You need at least one deployment configured in `yourcompany.ai.deployments`
- If using routing, ensure the `chat` route points to a valid deployment name

## Uninstalling

1. Open the Extensions sidebar (`Ctrl+Shift+X`)
2. Find **Your Company AI Assistant**
3. Click **Uninstall**
4. Reload VS Code
5. Optionally, remove the settings from your `settings.json`

---
applyTo: '**/byok/**'
description: Azure provider settings format and configuration guidelines
---

# Azure Provider Settings Configuration

Guidelines for configuring Azure OpenAI models in the BYOK (Bring Your Own Key) system using the `chat.azureModels` VS Code setting.

## Settings Format

The `chat.azureModels` setting accepts a record of model configurations where each key is a unique model identifier and the value is a model configuration object.

### Model Configuration Schema

```typescript
{
  "chat.azureModels": {
    "[modelId]": {
      "name": string,                    // Display name for the model
      "url": string,                     // Azure endpoint URL (base URL without API path)
      "deploymentType": "completions" | "responses",  // API type (default: "completions")
      "deploymentName": string,          // Azure deployment name (optional, defaults to modelId)
      "apiVersion": string,              // Azure API version (optional, default: "2025-01-01-preview")
      "maxInputTokens": number,          // Maximum input context window size
      "maxOutputTokens": number,         // Maximum output tokens per response
      "toolCalling": boolean,            // Whether model supports function/tool calling
      "temperature": number,             // Temperature setting (optional, 0.0-2.0)
      "thinking": boolean                // Whether model supports thinking/reasoning tokens (optional)
      "vision": boolean,                 // Whether model supports vision/image inputs (optional)
    }
  }
}
```

## URL Resolution Behavior

### Base URL Format
The `url` field should contain the **base Azure endpoint URL** without the API path:

```json
// ✅ Correct - base URL only
"url": "https://my-resource.openai.azure.com"
"url": "https://my-resource.models.ai.azure.com"

// ❌ Wrong - includes API path
"url": "https://my-resource.openai.azure.com/openai/deployments/gpt-4/chat/completions"
```

### Deployment Types

#### 1. Chat Completions API (`deploymentType: "completions"`)
**Default deployment type.** Uses the standard Azure OpenAI Chat Completions endpoint.

- **URL Pattern**: Deployment name is included in the URL path
- **Azure OpenAI endpoints** (`openai.azure.com`):
  - Resolved URL: `{url}/openai/deployments/{deploymentName}/chat/completions?api-version={apiVersion}`
- **Azure AI endpoints** (`models.ai.azure.com`, `inference.ml.azure.com`):
  - Resolved URL: `{url}/v1/chat/completions`

**Example Configuration:**
```json
{
  "chat.azureModels": {
    "gpt-4-turbo": {
      "name": "GPT-4 Turbo",
      "url": "https://my-resource.openai.azure.com",
      "deploymentType": "completions",
      "deploymentName": "gpt-4-turbo-deployment",
      "apiVersion": "2024-08-01-preview",
      "maxInputTokens": 128000,
      "maxOutputTokens": 4096,
      "toolCalling": true,
      "temperature": 0.7,
      "thinking": false,
      "vision": false
    }
  }
}
```

#### 2. Responses API (`deploymentType: "responses"`)
Uses the Azure OpenAI Responses API for streaming responses with structured outputs.

- **URL Pattern**: Deployment name is sent in the request body, NOT in URL
- **Azure OpenAI endpoints** (`openai.azure.com`):
  - Resolved URL: `{url}/openai/responses?api-version={apiVersion}`
- **Azure AI endpoints** (`models.ai.azure.com`, `inference.ml.azure.com`):
  - Resolved URL: `{url}/v1/responses?api-version={apiVersion}`
- **Model Field**: The `deploymentName` is passed as the `model` field in the request body

**Example Configuration:**
```json
{
  "chat.azureModels": {
    "o1-preview": {
      "name": "OpenAI o1-preview",
      "url": "https://my-resource.openai.azure.com",
      "deploymentType": "responses",
      "deploymentName": "o1-preview-deployment",
      "apiVersion": "2025-01-01-preview",
      "maxInputTokens": 128000,
      "maxOutputTokens": 32768,
      "toolCalling": false,
      "temperature": 1.0,
      "thinking": true,
      "vision": true
    }
  }
}
```

### Deployment Name Behavior

- **If `deploymentName` is provided**: Uses the specified deployment name
- **If `deploymentName` is omitted**: Falls back to using `modelId` as the deployment name
- **For Completions API**: Deployment name is included in the URL path
- **For Responses API**: Deployment name is sent as the `model` field in the request body

## Implementation Details

### URL Resolution Logic (`resolveAzureUrl`)

The `resolveAzureUrl` function in `azureProvider.ts` handles URL construction:

1. **Strips trailing slashes and `/v1` suffixes** from base URLs
2. **Detects endpoint type** based on URL patterns:
   - Azure AI: `models.ai.azure.com`, `inference.ml.azure.com`
   - Azure OpenAI: `openai.azure.com`, `cognitiveservices.azure.com`
3. **Applies deployment-specific URL patterns** based on `deploymentType`
4. **Uses defaults** if optional fields are omitted:
   - `deploymentType`: `"completions"`
   - `deploymentName`: Falls back to `modelId`
   - `apiVersion`: `"2025-01-01-preview"`

### Model Info Resolution (`getModelInfo`)

The `getModelInfo` method in `AzureBYOKModelProvider`:

1. **Retrieves deployment configuration** from settings
2. **For Responses API**: Overrides the model name to use `deploymentName` (sent in request body)
3. **For Completions API**: Uses `deploymentName` in URL path
4. **Sets `modelInfo.id`** to the deployment name for proper API routing
5. **Configures `supported_endpoints`**:
   - Responses API: `[ModelSupportedEndpoint.Responses]`
   - Completions API: `[ModelSupportedEndpoint.ChatCompletions]`
6. **Applies temperature** from configuration if specified

### API Key Management

- API keys are stored securely using VS Code's secrets storage
- Keys are stored per-model using the pattern: `copilot-byok-Azure-{modelId}-api-key`
- The `requiresAPIKey` field controls whether authentication is required (default: `true`)
- Users configure API keys through the UI or via commands

## Best Practices

1. **Use explicit deployment names**: Always specify `deploymentName` to avoid confusion with model IDs
2. **Match API versions**: Use the API version that matches your Azure deployment capabilities
3. **Set accurate token limits**: Configure `maxInputTokens` and `maxOutputTokens` based on your deployment
4. **Enable appropriate capabilities**: Set `toolCalling`, `thinking` and `vision`, flags based on model support
5. **Test endpoint URLs**: Verify base URLs are correct and accessible before adding models
6. **Group related models**: Use descriptive model IDs for easy identification in the UI
7. **Document custom configurations**: Add comments in settings.json to explain non-standard configurations

## Troubleshooting

### Common Issues

**Issue**: Model not appearing in selection
- **Check**: Ensure all required fields are present in configuration

**Issue**: 404 errors when using model
- **Check**: Verify `deploymentName` matches your Azure deployment
- **Check**: Ensure `url` points to the correct Azure resource
- **Check**: Confirm `apiVersion` is supported by your deployment

**Issue**: Unsupported endpoint errors
- **Check**: Verify `deploymentType` matches your deployment's API type
- **Check**: For reasoning models (o1), use `deploymentType: "responses"`

**Issue**: Model name mismatches in API calls
- **For Responses API**: Ensure `deploymentName` is set (it's sent as the model name)
- **For Completions API**: Deployment name is in URL, not request body

## Related Files

- Implementation: `src/extension/byok/vscode-node/azureProvider.ts`
- Base provider: `src/extension/byok/vscode-node/customOAIProvider.ts`
- Configuration: `src/platform/configuration/common/configurationService.ts`
- Storage: `src/extension/byok/vscode-node/byokStorageService.ts`

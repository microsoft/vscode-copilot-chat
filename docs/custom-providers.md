# Custom OpenAI-Compatible Providers

This feature allows you to configure custom OpenAI-compatible model providers in GitHub Copilot Chat. You can add multiple providers with their own base URLs and API keys.

## Configuration

Add custom providers to your VS Code settings:

```json
{
  "github.copilot.chat.byok.customProviders": [
    {
      "name": "Local LLM",
      "baseUrl": "http://localhost:8000/v1",
      "apiKey": "your-api-key",
      "enabled": true
    },
    {
      "name": "Custom Cloud Provider",
      "baseUrl": "https://api.example.com/v1",
      "apiKey": "your-custom-api-key",
      "enabled": true
    }
  ]
}
```

## Supported Providers

Any OpenAI-compatible API that implements **both of** the following endpoints:
- `GET /models` - List available models
- `POST /chat/completions` - Chat completions with streaming support

### Examples of Compatible Providers

1. **Local LLMs**:
   - Ollama (which already has dedicated support)
   - LM Studio
   - LocalAI
   - Text Generation WebUI

2. **Cloud Providers**:
   - Together AI
   - Anyscale
   - Fireworks AI
   - Perplexity AI
   - Any custom deployment

3. **Self-hosted**:
   - vLLM
   - TGI (Text Generation Inference)
   - FastChat
   - Custom OpenAI-compatible servers

## Configuration Properties

| Property | Type | Required | Description |
|----------|------|----------|-------------|
| `name` | string | Yes | Display name for the provider |
| `baseUrl` | string | Yes | Base URL for the API (e.g., `https://api.example.com/v1`) |
| `apiKey` | string | No | API key for authentication (optional for providers that don't require auth) |
| `enabled` | boolean | No | Whether the provider is enabled (default: true) |

## Features

- ✅ **Multiple Providers**: Configure multiple custom providers simultaneously
- ✅ **Streaming Support**: Full streaming support for real-time responses
- ✅ **Model Discovery**: Automatically discovers available models from each provider
- ✅ **Individual API Keys**: Each provider can have its own API key
- ✅ **Enable/Disable**: Toggle providers on/off without removing configuration
- ✅ **Error Handling**: Graceful handling of connection and authentication errors
- ✅ **Validation**: Built-in validation of provider configurations

## Usage

1. **Configure Providers**: Add your custom providers to VS Code settings
2. **Restart Extension**: Reload VS Code or restart the Copilot extension
3. **Manage Models**: Use the "Manage Models" command to select models from your custom providers
4. **Chat**: Use the models in Copilot Chat just like any other provider

## Example Configurations

### Local LM Studio
```json
{
  "name": "LM Studio",
  "baseUrl": "http://localhost:1234/v1",
  "apiKey": "lm-studio",
  "enabled": true
}
```

### Together AI
```json
{
  "name": "Together AI",
  "baseUrl": "https://api.together.xyz/v1",
  "apiKey": "your-together-api-key",
  "enabled": true
}
```

### Anyscale
```json
{
  "name": "Anyscale",
  "baseUrl": "https://api.endpoints.anyscale.com/v1",
  "apiKey": "your-anyscale-api-key",
  "enabled": true
}
```

### Self-hosted vLLM
```json
{
  "name": "My vLLM Server",
  "baseUrl": "https://my-vllm-server.com/v1",
  "apiKey": "optional-api-key",
  "enabled": true
}
```

### Local Provider Without Authentication
```json
{
  "name": "Local Model Server",
  "baseUrl": "http://localhost:8080/v1",
  "enabled": true
}
```

## Troubleshooting

### Provider Not Appearing
- Check that `enabled` is set to `true`
- Verify the base URL is correct and accessible
- Ensure the API key is valid
- Restart VS Code after configuration changes

### Models Not Loading
- Verify the provider implements the `/models` endpoint
- Check that the API key has permission to list models
- Look for errors in the VS Code Developer Console

### Connection Errors
- Ensure the base URL is reachable from your machine
- Check firewall and network settings for local providers
- Verify SSL certificates for HTTPS endpoints

### Authentication Issues
- Double-check the API key format and validity
- Some providers may require specific header formats
- Check provider documentation for authentication requirements

## Security Notes

- **⚠️ API keys are stored in plain text** in VS Code settings (`settings.json`)
- Settings are synced to the cloud by default - be cautious about credential exposure
- Consider using environment variables for sensitive keys: `"apiKey": "${env:MY_PROVIDER_API_KEY}"`
- Be cautious when sharing settings files that contain API keys
- Local providers (localhost) are generally safer for experimentation
- VS Code's Settings Sync may expose credentials - review [VS Code's secret storage guidance](https://code.visualstudio.com/docs/editor/settings-sync#_secrets-and-authentications)

## Limitations

- Providers must be OpenAI-compatible (same API format)
- Some advanced OpenAI features may not be supported by all providers
- Model capabilities are auto-detected but may need manual configuration
- Rate limiting depends on the individual provider's policies

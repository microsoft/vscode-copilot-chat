# VS Code Server & Code Server Compatibility

GitHub Copilot Chat is fully compatible with all VS Code variants including VS Code Server, Code Server, VSCodium, and web-based environments.

## Supported Environments

### ✅ **Desktop VS Code**
- VS Code (Stable)
- VS Code Insiders
- VS Code Exploration
- VSCodium

### ✅ **Remote Development**
- VS Code Server (official Microsoft)
- Remote - SSH
- Remote - Containers
- Remote - WSL
- GitHub Codespaces

### ✅ **Web-Based Environments**
- Code Server (Coder)
- VS Code for the Web (vscode.dev)
- GitHub.dev
- Gitpod
- Replit
- CodeSandbox

### ✅ **Self-Hosted Solutions**
- code-server (open source)
- OpenVSCode Server
- Theia IDE
- Eclipse Che

## Installation

### Method 1: VS Code Marketplace (Recommended)
```bash
# Install from marketplace
code --install-extension GitHub.copilot-chat
```

### Method 2: Manual Installation
1. Download the `.vsix` file from releases
2. Install manually:
```bash
code --install-extension copilot-chat-x.x.x.vsix
```

### Method 3: Code Server
```bash
# For code-server environments
code-server --install-extension GitHub.copilot-chat
```

## Configuration

### Environment Variables
The extension automatically detects the environment and adapts accordingly:

```bash
# Optional: Set custom provider configurations
export COPILOT_CUSTOM_PROVIDER_API_KEY="your-api-key"
export COPILOT_CUSTOM_PROVIDER_URL="https://your-provider.com/v1"
```

### Settings for Different Environments

#### VS Code Server
```json
{
  "github.copilot.chat.byok.customProviders": [
    {
      "name": "Local Provider",
      "baseUrl": "http://localhost:8080/v1",
      "enabled": true
    }
  ]
}
```

#### Code Server
```json
{
  "github.copilot.enable": {
    "*": true
  },
  "github.copilot.chat.enabled": true
}
```

## Features Available in All Environments

### ✅ **Core Chat Features**
- AI-powered chat conversations
- Code generation and explanation
- Inline code suggestions
- Multi-turn conversations

### ✅ **Custom Provider Support**
- OpenAI-compatible API providers
- Local LLM servers (Ollama, LM Studio, etc.)
- Cloud providers (Together AI, Anyscale, etc.)
- Authentication-free providers

### ✅ **File Operations**
- Read and analyze files
- Generate new files
- Code refactoring
- Documentation generation

### ✅ **Workspace Integration**
- Project context awareness
- Multi-file operations
- Git integration
- Terminal commands

## Environment-Specific Considerations

### VS Code Server
- Full feature parity with desktop VS Code
- Supports all custom providers
- Terminal integration available
- File system access unrestricted

### Code Server
- Web-based interface limitations apply
- Some terminal features may be restricted
- File upload/download through browser
- Network-based custom providers recommended

### Web Environments (vscode.dev, github.dev)
- Limited file system access
- Network requests may be restricted
- Custom providers must be HTTPS
- Some Node.js specific features unavailable

## Troubleshooting

### Common Issues

#### Extension Not Loading
```bash
# Check VS Code version compatibility
code --version

# Minimum required: VS Code 1.85.0
# Update if necessary
```

#### Custom Provider Connection Issues
```bash
# Test provider connectivity
curl -X GET "https://your-provider.com/v1/models" \
  -H "Authorization: Bearer your-api-key"
```

#### Authentication Problems
1. Ensure GitHub Copilot subscription is active
2. Sign in to GitHub account in VS Code
3. Check network connectivity
4. Verify firewall settings

### Environment-Specific Fixes

#### VS Code Server
```bash
# Restart the server
sudo systemctl restart code-server

# Check logs
journalctl -u code-server -f
```

#### Code Server
```bash
# Update code-server
npm update -g code-server

# Clear extension cache
rm -rf ~/.local/share/code-server/extensions
```

## Performance Optimization

### For Remote Environments
```json
{
  "github.copilot.advanced.length": 500,
  "github.copilot.chat.localeOverride": "en",
  "github.copilot.chat.welcomeMessage": "disabled"
}
```

### For Low-Bandwidth Connections
```json
{
  "github.copilot.enable": {
    "*": true,
    "plaintext": false,
    "markdown": false
  }
}
```

## Security Considerations

### Network Security
- Use HTTPS for all custom providers
- Implement proper authentication
- Consider VPN for sensitive environments

### Data Privacy
- Custom providers handle your code
- Review provider privacy policies
- Use local providers for sensitive code

### Access Control
```json
{
  "github.copilot.chat.byok.customProviders": [
    {
      "name": "Internal Provider",
      "baseUrl": "https://internal.company.com/v1",
      "apiKey": "${env:INTERNAL_API_KEY}",
      "enabled": true
    }
  ]
}
```

## Support

### Getting Help
1. Check [GitHub Issues](https://github.com/microsoft/vscode/issues)
2. Review [VS Code Documentation](https://code.visualstudio.com/docs)
3. Join [GitHub Community Discussions](https://github.com/github-community/community/discussions/categories/copilot)

### Reporting Issues
When reporting issues, include:
- VS Code variant and version
- Environment details (server, web, etc.)
- Extension version
- Error messages and logs
- Steps to reproduce

## Version Compatibility

| VS Code Version | Extension Support | Notes |
|----------------|------------------|-------|
| 1.85.0+ | ✅ Full Support | Recommended minimum |
| 1.80.0-1.84.x | ⚠️ Limited | Some features may not work |
| < 1.80.0 | ❌ Not Supported | Please upgrade |

## Contributing

The extension is designed to work across all VS Code environments. When contributing:

1. Test changes in multiple environments
2. Avoid platform-specific dependencies
3. Use feature detection over environment detection
4. Document environment-specific behavior

For more information, see [CONTRIBUTING.md](../CONTRIBUTING.md).

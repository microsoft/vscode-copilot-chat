const fs = require('fs');
const path = 'src/platform/configuration/common/configurationService.ts';
let code = fs.readFileSync(path, 'utf8');

// We need to remove these from the Deprecated namespace:
// OllamaEndpoint, AzureModels, CustomOAIModels, AzureAuthType
// Let's use string replacement or regex

code = code.replace(/\s*export const OllamaEndpoint = defineSetting<string>\('chat\.byok\.ollamaEndpoint', ConfigType\.Simple, 'http:\/\/localhost:11434'\);/, '');
code = code.replace(/\s*export const AzureModels = defineSetting<Record<string, \{ name: string; url: string; toolCalling: boolean; vision: boolean; maxInputTokens: number; maxOutputTokens: number; requiresAPIKey\?: boolean; thinking\?: boolean; streaming\?: boolean; zeroDataRetentionEnabled\?: boolean \}>\>\('chat\.azureModels', ConfigType\.Simple, \{\}\);/, '');
code = code.replace(/\s*export const CustomOAIModels = defineSetting<Record<string, \{ name: string; url: string; toolCalling: boolean; vision: boolean; maxInputTokens: number; maxOutputTokens: number; requiresAPIKey\?: boolean; thinking\?: boolean; streaming\?: boolean; requestHeaders\?: Record<string, string>; zeroDataRetentionEnabled\?: boolean \}>\>\('chat\.customOAIModels', ConfigType\.Simple, \{\}\);/, '');
code = code.replace(/\s*export const AzureAuthType = defineSetting<AzureAuthMode>\('chat\.azureAuthType', ConfigType\.Simple, AzureAuthMode\.EntraId\);/, '');

fs.writeFileSync(path, code);

/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { RequestType } from '@vscode/copilot-api';
import { TokenizerType } from '../../../util/common/tokenizer';
import { IInstantiationService } from '../../../util/vs/platform/instantiation/common/instantiation';
import { IModelRouter } from '../../azure/common/modelRouter';
import { CHAT_MODEL, IConfigurationService } from '../../configuration/common/configurationService';
import { IChatModelInformation } from '../common/endpointProvider';
import { ChatEndpoint } from './chatEndpoint';

export function createProxyXtabEndpoint(
	instaService: IInstantiationService,
	overriddenModelName: string | undefined,
) {
	// Azure-only fork: route NES through the user's Azure endpoint
	// instead of the CAPI proxy which points to GitHub
	const configService = instaService.invokeFunction(acc => acc.get(IConfigurationService));
	const azureEndpoint = configService.getNonExtensionConfig<string>('yourcompany.ai.endpoint');

	let urlOrRequestMetadata: IChatModelInformation['urlOrRequestMetadata'];
	let modelId: string;

	if (azureEndpoint) {
		const modelRouter = instaService.invokeFunction(acc => acc.get(IModelRouter));
		const deployment = modelRouter.getDeployment('chat');
		// Azure-only fork: always use the model router's deployment name, not the
		// Copilot-specific model name (e.g. 'copilot-nes-oct') which doesn't
		// correspond to an actual Azure OpenAI deployment.
		modelId = deployment.deploymentName;
		const baseUrl = azureEndpoint.replace(/\/$/, '');
		urlOrRequestMetadata = `${baseUrl}/openai/deployments/${modelId}/chat/completions?api-version=${deployment.apiVersion}`;
	} else {
		modelId = overriddenModelName ?? CHAT_MODEL.NES_XTAB;
		urlOrRequestMetadata = { type: RequestType.ProxyChatCompletions };
	}

	const defaultInfo: IChatModelInformation = {
		id: modelId,
		urlOrRequestMetadata,
		name: 'xtab-proxy',
		model_picker_enabled: false,
		is_chat_default: false,
		is_chat_fallback: false,
		version: 'unknown',
		capabilities: {
			type: 'chat',
			family: 'xtab-proxy',
			tokenizer: TokenizerType.O200K,
			limits: {
				max_prompt_tokens: 12285,
				max_output_tokens: 4096,
			},
			supports: {
				streaming: true,
				parallel_tool_calls: false,
				tool_calls: false,
				vision: false,
				prediction: true,
			}
		}
	};
	return instaService.createInstance(ChatEndpoint, defaultInfo);
}

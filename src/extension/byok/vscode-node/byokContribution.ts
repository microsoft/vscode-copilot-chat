/*---------------------------------------------------------------------------------------------
 *  Azure-only fork: BYOK contribution stripped to Azure OpenAI only.
 *  All non-Azure providers (Ollama, Anthropic, Gemini, xAI, OpenAI, OpenRouter, Custom OAI)
 *  have been removed. Models come exclusively from the user's Azure OpenAI configuration.
 *--------------------------------------------------------------------------------------------*/
import { lm } from 'vscode';
import { ILogService } from '../../../platform/log/common/logService';
import { Disposable } from '../../../util/vs/base/common/lifecycle';
import { IInstantiationService } from '../../../util/vs/platform/instantiation/common/instantiation';
import { IExtensionContribution } from '../../common/contributions';
import { AzureOnlyModelProvider } from './azureOnlyProvider';

export class BYOKContrib extends Disposable implements IExtensionContribution {
	public readonly id: string = 'byok-contribution';
	private _registered = false;

	constructor(
		@ILogService private readonly _logService: ILogService,
		@IInstantiationService private readonly _instantiationService: IInstantiationService,
	) {
		super();
		this._registerAzureProvider();
	}

	private _registerAzureProvider(): void {
		if (this._registered) {
			return;
		}
		this._registered = true;

		this._logService.info('Azure-only fork: Registering Azure OpenAI model provider.');
		const azureProvider = this._instantiationService.createInstance(AzureOnlyModelProvider);
		this._store.add(lm.registerLanguageModelChatProvider(AzureOnlyModelProvider.providerName, azureProvider));
		this._logService.info('Azure-only fork: Azure OpenAI model provider registered.');
	}
}

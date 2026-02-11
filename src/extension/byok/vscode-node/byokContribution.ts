/*---------------------------------------------------------------------------------------------
 *  Azure-only fork: BYOK contribution stripped to Azure OpenAI only.
 *  All non-Azure providers (Ollama, Anthropic, Gemini, xAI, OpenAI, OpenRouter, Custom OAI)
 *  have been removed. Models come exclusively from the user's Azure OpenAI configuration.
 *--------------------------------------------------------------------------------------------*/
import * as vscode from 'vscode';
import { IVSCodeExtensionContext } from '../../../platform/extContext/common/extensionContext';
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
		@IVSCodeExtensionContext private readonly _extensionContext: IVSCodeExtensionContext,
	) {
		super();
		this._registerAzureProvider();
		this._registerCommands();
	}

	private _registerAzureProvider(): void {
		if (this._registered) {
			return;
		}
		this._registered = true;

		this._logService.info('Azure-only fork: Registering Azure OpenAI model provider.');
		const azureProvider = this._instantiationService.createInstance(AzureOnlyModelProvider);
		this._store.add(vscode.lm.registerLanguageModelChatProvider(AzureOnlyModelProvider.providerName, azureProvider));
		this._logService.info('Azure-only fork: Azure OpenAI model provider registered.');
	}

	private _registerCommands(): void {
		this._store.add(vscode.commands.registerCommand('yourcompany.ai.updateSecret', async () => {
			const secret = await vscode.window.showInputBox({
				prompt: 'Enter the Azure AD client secret for service principal authentication',
				password: true,
				placeHolder: 'Client secret value',
				ignoreFocusOut: true,
			});
			if (secret === undefined) {
				return; // user cancelled
			}
			await this._extensionContext.secrets.store('yourcompany.ai.clientSecret', secret);
			this._logService.info('Azure-only fork: Client secret updated in SecretStorage.');
			vscode.window.showInformationMessage('Client secret updated. Reload the window to apply.');
		}));
	}
}

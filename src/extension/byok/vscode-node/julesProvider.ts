/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { IBYOKStorageService } from './byokStorageService';
import { BYOKAuthType, BYOKModelProvider, handleAPIKeyUpdate } from '../common/byokProvider';
import { window } from 'vscode';
import type { LanguageModelChatInformation } from 'vscode';

export class JulesProvider implements BYOKModelProvider<LanguageModelChatInformation> {
    public static readonly providerName = 'jules';
    public readonly authType = BYOKAuthType.GlobalApiKey;

    constructor(
        private readonly _storageService: IBYOKStorageService
    ) { }

    public async updateAPIKey(): Promise<void> {
        await handleAPIKeyUpdate(JulesProvider.providerName.toLowerCase(), this._storageService, async (providerName, reconfigure) => {
            const result = await window.showInputBox({
                title: reconfigure ? `Update API Key for ${JulesProvider.providerName}` : `Enter API Key for ${JulesProvider.providerName}`,
                prompt: 'Enter your Jules API Key',
                password: true,
                ignoreFocusOut: true
            });
            return result;
        });
    }

    public async updateAPIKeyViaCmd(envVarName: string, action: 'update' | 'remove'): Promise<void> {
        if (action === 'remove') {
            await this._storageService.deleteAPIKey(JulesProvider.providerName.toLowerCase(), this.authType);
        } else {
            const apiKey = process.env[envVarName];
            if (apiKey) {
                await this._storageService.storeAPIKey(JulesProvider.providerName.toLowerCase(), apiKey, this.authType);
            }
        }
    }

    public async prepareChat(context: any): Promise<any> {
        // Not used for agents usually, but required by interface if we registered it as a LM provider.
        // Since we are not registering it as LM provider, this method is not called.
        // But BYOKModelProvider extends LanguageModelChatProvider.
        throw new Error('Method not implemented.');
    }

    // Required by LanguageModelChatProvider
    async sendChatRequest(): Promise<any> {
         throw new Error('Method not implemented.');
    }
}

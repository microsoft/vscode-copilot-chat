/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type * as vscode from 'vscode';
import { URI } from '../../../util/vs/base/common/uri';
import { IInstantiationService } from '../../../util/vs/platform/instantiation/common/instantiation';
import { OpenAILanguageModelServer } from './oaiLanguageModelServer';

export class LanguageModelProxyProvider implements vscode.LanguageModelProxyProvider {
	private readonly langModelServers = new Map<string, OpenAILanguageModelServer>();

	constructor(
		@IInstantiationService private readonly instantiationService: IInstantiationService
	) { }

	async provideModelProxy(forExtensionId: string, token: vscode.CancellationToken): Promise<vscode.LanguageModelProxyInfo | undefined> {
		const server = await this.getLangModelServer(forExtensionId);
		const config = server.getConfig();

		return {
			uri: URI.parse(`http://localhost:${config.port}`),
			key: config.nonce
		};
	}

	private async getLangModelServer(forExtensionId: string): Promise<OpenAILanguageModelServer> {
		let server = this.langModelServers.get(forExtensionId);
		if (!server) {
			server = this.instantiationService.createInstance(OpenAILanguageModelServer);
			this.langModelServers.set(forExtensionId, server);
			try {
				await server.start();
			} catch (startError) {
				this.langModelServers.delete(forExtensionId);
				throw startError;
			}
		}

		return server;
	}
}
/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { lm } from 'vscode';
import { ConfigKey, IConfigurationService } from '../../../platform/configuration/common/configurationService';
import { IExperimentationService } from '../../../platform/telemetry/common/nullExperimentationService';
import { Disposable, IDisposable } from '../../../util/vs/base/common/lifecycle';
import { GitHubMcpDefinitionProvider } from '../common/githubMcpDefinitionProvider';

export class GitHubMcpContrib extends Disposable {
	private disposable?: IDisposable;
	private definitionProvider?: GitHubMcpDefinitionProvider;

	constructor(
		@IConfigurationService private readonly configurationService: IConfigurationService,
		@IExperimentationService private readonly experimentationService: IExperimentationService,
	) {
		super();
		this._registerConfigurationListener();
		if (this.enabled) {
			this._registerGitHubMcpDefinitionProvider();
		}
	}

	private _registerConfigurationListener() {
		this.configurationService.onDidChangeConfiguration(e => {
			if (e.affectsConfiguration(ConfigKey.GitHubMcpEnabled.fullyQualifiedId)) {
				if (this.enabled) {
					this._registerGitHubMcpDefinitionProvider();
				} else {
					this.disposable?.dispose();
					this.disposable = undefined;
					this.definitionProvider = undefined;
				}
			}
		});
	}

	private _registerGitHubMcpDefinitionProvider() {
		if (!this.definitionProvider) {
			// Register the GitHub MCP Definition Provider
			this.definitionProvider = new GitHubMcpDefinitionProvider(this.configurationService);
			this.disposable = lm.registerMcpServerDefinitionProvider('github', this.definitionProvider);
		}
	}

	private get enabled(): boolean {
		return this.configurationService.getExperimentBasedConfig(ConfigKey.GitHubMcpEnabled, this.experimentationService);
	}
}

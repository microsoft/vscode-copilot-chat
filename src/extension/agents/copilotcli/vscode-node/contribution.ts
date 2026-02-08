/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { ConfigKey, IConfigurationService } from '../../../../platform/configuration/common/configurationService';
import { ILogger, ILogService } from '../../../../platform/log/common/logService';
import { Disposable } from '../../../../util/vs/base/common/lifecycle';
import { IInstantiationService } from '../../../../util/vs/platform/instantiation/common/instantiation';
import { IExtensionContribution } from '../../../common/contributions';
import { registerAddFileReferenceCommand, registerDiffCommands } from './commands';
import { DiffStateManager } from './diffState';
import { InProcHttpServer } from './inProcHttpServer';
import { cleanupStaleLockFiles, createLockFile } from './lockFile';
import { ReadonlyContentProvider } from './readonlyContentProvider';
import { registerTools, SelectionState } from './tools';
import { registerDiagnosticsChangedNotification, registerSelectionChangedNotification } from './tools/push';

export class CopilotCLIContrib extends Disposable implements IExtensionContribution {
	readonly id = 'copilotCLI';
	private initialized: boolean = false;
	constructor(
		@IInstantiationService _instantiationService: IInstantiationService,
		@ILogService private readonly logService: ILogService,
		@IConfigurationService private readonly configurationService: IConfigurationService,
	) {
		super();

		this.configurationService.onDidChangeConfiguration(e => {
			if (e.affectsConfiguration(ConfigKey.Advanced.CLIIntegrationEnabled.id)) {
				this.initialize();
			}
		});
		this.initialize();
	}

	private initialize() {
		if (this.initialized) {
			return;
		}
		if (!this.configurationService.getConfig(ConfigKey.Advanced.CLIIntegrationEnabled)) {
			return;
		}

		this.initialized = true;
		const logger = this.logService.createSubLogger('CopilotCLI');

		// Create shared instances
		const diffState = new DiffStateManager(logger);
		const httpServer = new InProcHttpServer(logger);
		const selectionState = new SelectionState();
		const contentProvider = new ReadonlyContentProvider();

		// Register commands
		this._register(registerAddFileReferenceCommand(logger, httpServer));
		for (const d of registerDiffCommands(logger, diffState)) {
			this._register(d);
		}
		for (const d of diffState.setupContextTracking()) {
			this._register(d);
		}
		this._register(contentProvider.register());

		// Clean up any stale lockfiles from previous sessions
		const cleanedCount = cleanupStaleLockFiles(logger);
		if (cleanedCount > 0) {
			logger.info(`Cleaned up ${cleanedCount} stale lock file(s).`);
		}

		// Start the MCP server
		this._startMcpServer(logger, httpServer, diffState, selectionState, contentProvider);
	}
	private async _startMcpServer(logger: ILogger, httpServer: InProcHttpServer, diffState: DiffStateManager, selectionState: SelectionState, contentProvider: ReadonlyContentProvider): Promise<void> {
		try {
			const { disposable, serverUri, headers } = await httpServer.start({
				id: 'vscode-copilot-cli',
				serverLabel: 'VS Code Copilot CLI',
				serverVersion: '0.0.1',
				registerTools: server => {
					registerTools(server, logger, diffState, selectionState, contentProvider);
				},
				registerPushNotifications: () => {
					for (const d of registerSelectionChangedNotification(logger, httpServer, selectionState)) {
						this._register(d);
					}
					for (const d of registerDiagnosticsChangedNotification(logger, httpServer)) {
						this._register(d);
					}
				},
			});

			const lockFile = await createLockFile(serverUri, headers, logger);
			logger.info(`MCP server started. Lock file: ${lockFile.path}`);
			logger.info(`Server URI: ${serverUri.toString()}`);

			// Update lock file when workspace folders change
			this._register(vscode.workspace.onDidChangeWorkspaceFolders(() => {
				lockFile.update();
				logger.info('Workspace folders changed, lock file updated.');
			}));

			this._register(disposable);
			this._register({ dispose: () => lockFile.remove() });
		} catch (err) {
			const errMsg = err instanceof Error ? err.message : String(err);
			logger.error(`Failed to start MCP server: ${errMsg}`);
		}
	}
}

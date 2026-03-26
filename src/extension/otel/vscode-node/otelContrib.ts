/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { ILogService } from '../../../platform/log/common/logService';
import { IOTelService } from '../../../platform/otel/common/otelService';
import { IOTelSqliteStore, type OTelSqliteStore } from '../../../platform/otel/node/sqlite/otelSqliteStore';
import { Disposable } from '../../../util/vs/base/common/lifecycle';
import type { IExtensionContribution } from '../../common/contributions';

/**
 * Lifecycle contribution that logs OTel status, wires the SQLite store,
 * and shuts down the SDK on extension deactivation.
 */
export class OTelContrib extends Disposable implements IExtensionContribution {

	constructor(
		@IOTelService private readonly _otelService: IOTelService,
		@IOTelSqliteStore private readonly _sqliteStore: OTelSqliteStore,
		@ILogService private readonly _logService: ILogService,
	) {
		super();
		if (this._otelService.config.enabled) {
			this._logService.info(`[OTel] Instrumentation enabled — exporter=${this._otelService.config.exporterType} endpoint=${this._otelService.config.otlpEndpoint} captureContent=${this._otelService.config.captureContent}`);
		} else {
			this._logService.trace('[OTel] Instrumentation disabled');
		}

		// Wire span completion to SQLite store for ATIF trajectory export
		this._register(this._otelService.onDidCompleteSpan(span => {
			try {
				this._sqliteStore.insertSpan(span);
			} catch (err) {
				this._logService.error('[OTel] Failed to insert span into SQLite store:', String(err));
			}
		}));

		this._register(vscode.commands.registerCommand('github.copilot.chat.otel.flush', async () => {
			if (!this._otelService.config.enabled) {
				return;
			}
			this._logService.info('[OTel] Flush requested — exporting pending traces, metrics, and events');
			await this._otelService.flush();
			this._logService.info('[OTel] Flush complete');
		}));

		// Export the agent-traces.db file to a specified directory.
		// Used by the eval harness to copy the SQLite DB for ATIF conversion.
		this._register(vscode.commands.registerCommand('github.copilot.chat.otel.exportTraces', async (savePath?: string) => {
			const dbPath = this._sqliteStore.dbPath;
			if (!dbPath) {
				return;
			}
			const destDir = savePath
				? vscode.Uri.file(savePath)
				: (await vscode.window.showOpenDialog({ canSelectFiles: false, canSelectFolders: true, canSelectMany: false, title: 'Export Agent Traces DB' }))?.[0];
			if (!destDir) {
				return;
			}
			const src = vscode.Uri.file(dbPath);
			const dest = vscode.Uri.joinPath(destDir, 'agent-traces.db');
			await vscode.workspace.fs.copy(src, dest, { overwrite: true });
			this._logService.info(`[OTel] Exported agent-traces.db to ${dest.fsPath}`);
		}));
	}

	override dispose(): void {
		// Close SQLite store before OTel shutdown
		this._sqliteStore.close();
		if (this._otelService.config.enabled) {
			this._logService.info('[OTel] Shutting down — flushing pending traces, metrics, and events');
		}
		this._otelService.shutdown().catch((err: Error) => {
			this._logService.error('[OTel] Error during shutdown:', String(err));
		});
		super.dispose();
	}
}

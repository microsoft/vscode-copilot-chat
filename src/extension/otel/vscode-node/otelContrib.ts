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

		// Wire span completion to SQLite store for trajectory export.
		// When dbSpanExporter is enabled with the OTel SDK (NodeOTelService), spans
		// flow through the SqliteSpanExporter pipeline — no fallback needed.
		// When dbSpanExporter is disabled (default), no spans are stored and no DB is created.
		// The onDidCompleteSpan fallback only activates in the edge case where
		// dbSpanExporter is on but OTel SDK failed to initialize.
		if (this._otelService.config.dbSpanExporter && !this._otelService.config.enabled) {
			this._register(this._otelService.onDidCompleteSpan(span => {
				try {
					this._sqliteStore.insertSpan(span);
				} catch (err) {
					this._logService.error('[OTel] Failed to insert span into SQLite store:', String(err));
				}
			}));
		}

		this._register(vscode.commands.registerCommand('github.copilot.chat.otel.flush', async () => {
			if (!this._otelService.config.enabled) {
				return;
			}
			this._logService.info('[OTel] Flush requested — exporting pending traces, metrics, and events');
			await this._otelService.flush();
			this._logService.info('[OTel] Flush complete');
		}));

		// Export the agent-traces.db file.
		// Programmatic (eval harness): called with savePath URI or string → copies DB there.
		// Interactive (command palette): shows save dialog with default filename.
		this._register(vscode.commands.registerCommand('github.copilot.chat.otel.exportAgentTracesDB', async (savePath?: vscode.Uri | string) => {
			const dbPath = this._sqliteStore.dbPath;
			if (!dbPath) {
				return;
			}
			const src = vscode.Uri.file(dbPath);
			let dest: vscode.Uri;

			if (savePath) {
				const saveUri = typeof savePath === 'string' ? vscode.Uri.file(savePath) : savePath;
				dest = vscode.Uri.joinPath(saveUri, 'agent-traces.db');
			} else {
				// Interactive: show save dialog with default filename
				const result = await vscode.window.showSaveDialog({
					defaultUri: vscode.Uri.file('agent-traces.db'),
					filters: { 'SQLite Database': ['db'] },
					title: 'Export Agent Traces DB',
				});
				if (!result) {
					return;
				}
				dest = result;
			}

			// Flush BatchSpanProcessors so all buffered spans are written to SQLite
			// before we checkpoint + copy. Without this, the root invoke_agent span
			// (which ends last) may still be in the processor's buffer.
			await this._otelService.flush();

			// Checkpoint WAL so all data is flushed into the main .db file before copying.
			// Without this, the copy would be empty because data lives in the -wal file.
			this._sqliteStore.checkpoint();

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

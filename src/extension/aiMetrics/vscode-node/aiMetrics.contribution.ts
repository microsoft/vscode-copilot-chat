/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { IConfigurationService } from '../../../platform/configuration/common/configurationService';
import { IVSCodeExtensionContext } from '../../../platform/extContext/common/extensionContext';
import { ILogService } from '../../../platform/log/common/logService';
import { Disposable } from '../../../util/vs/base/common/lifecycle';
import { IInstantiationService } from '../../../util/vs/platform/instantiation/common/instantiation';
import { IAiMetricsStorageService } from '../common/aiMetricsStorageService';
import { AiMetricsStorageService } from '../node/aiMetricsStorageService';
import { AiMetricsDashboardPanel } from './aiMetricsDashboardPanel';

/**
 * Contribution for AI Metrics Dashboard functionality
 */
export class AiMetricsContrib extends Disposable {
	private storageService: IAiMetricsStorageService | undefined;

	constructor(
		@IInstantiationService private readonly instantiationService: IInstantiationService,
		@IVSCodeExtensionContext private readonly extensionContext: IVSCodeExtensionContext,
		@IConfigurationService private readonly configurationService: IConfigurationService,
		@ILogService private readonly logService: ILogService,
	) {
		super();
		this.initialize();
	}

	private async initialize(): Promise<void> {
		// Create and register the storage service
		this.storageService = this.instantiationService.createInstance(AiMetricsStorageService);

		// Register the view metrics command
		this._register(
			vscode.commands.registerCommand('github.copilot.viewMetrics', () => {
				if (this.storageService) {
					AiMetricsDashboardPanel.createOrShow(
						this.extensionContext,
						this.storageService,
						this.logService
					);
				}
			})
		);

		// Prune old data on activation
		await this.storageService.pruneOldData();

		this.logService.info('[AiMetrics] AI Metrics contribution initialized');
	}
}

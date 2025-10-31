/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Heavily lifted from https://github.com/microsoft/vscode/tree/main/src/vs/workbench/common/configuration.ts
 * It is a little simplified and does not handle overrides, but currently we are only migrating experimental configurations
 */


import { ConfigurationTarget, Uri, window, workspace, WorkspaceFolder } from 'vscode';
import { Emitter } from '../../../util/vs/base/common/event';
import { DisposableStore, IDisposable } from '../../../util/vs/base/common/lifecycle';
import { localize } from '../../../util/vs/nls';
import { IExtensionContribution } from '../../common/contributions';


interface IConfigurationNode {
	id: string;
	title: string;
	type: string;
	order?: number;

}

export const applicationConfigurationNodeBase = Object.freeze<IConfigurationNode>({
	'id': 'application',
	'order': 100,
	'title': localize('applicationConfigurationTitle', "Application"),
	'type': 'object'
});

export const Extensions = {
	ConfigurationMigration: 'base.contributions.configuration.migration'
};

export type ConfigurationValue = { value: any | undefined /* Remove */ };
export type ConfigurationKeyValuePairs = [string, ConfigurationValue][];
export type ConfigurationMigrationFn = (value: any) => ConfigurationValue | ConfigurationKeyValuePairs | Promise<ConfigurationValue | ConfigurationKeyValuePairs>;
export type ConfigurationMigration = { key: string; migrateFn: ConfigurationMigrationFn };

export interface IConfigurationMigrationRegistry {
	registerConfigurationMigrations(configurationMigrations: ConfigurationMigration[]): void;
}

class ConfigurationMigrationRegistryImpl implements IConfigurationMigrationRegistry {
	readonly migrations: ConfigurationMigration[] = [];

	private readonly _onDidRegisterConfigurationMigrations = new Emitter<ConfigurationMigration[]>();
	readonly onDidRegisterConfigurationMigration = this._onDidRegisterConfigurationMigrations.event;

	registerConfigurationMigrations(configurationMigrations: ConfigurationMigration[]): void {
		this.migrations.push(...configurationMigrations);
	}
}

export const ConfigurationMigrationRegistry = new ConfigurationMigrationRegistryImpl();

export class ConfigurationMigrationContribution implements IExtensionContribution {
	private readonly _disposables = new DisposableStore();

	constructor() {
		this._register(workspace.onDidChangeWorkspaceFolders(async (e) => {
			for (const folder of e.added) {
				await this.migrateConfigurationForFolder(folder, ConfigurationMigrationRegistry.migrations);
			}
		}));
		this.migrateConfigurations(ConfigurationMigrationRegistry.migrations);
		this._register(ConfigurationMigrationRegistry.onDidRegisterConfigurationMigration(migration => this.migrateConfigurations(migration)));
	}

	private async migrateConfigurations(migrations: ConfigurationMigration[]): Promise<void> {
		if (window.state.focused) {
			await this.migrateConfigurationForFolder(undefined, migrations);
			for (const folder of workspace.workspaceFolders ?? []) {
				await this.migrateConfigurationForFolder(folder, migrations);
			}
		}
	}

	private async migrateConfigurationForFolder(folder: WorkspaceFolder | undefined, migrations: ConfigurationMigration[]): Promise<void> {
		await Promise.all([migrations.map(migration => this.migrateConfigurationsForFolder(migration, folder?.uri))]);
	}

	private async migrateConfigurationsForFolder(migration: ConfigurationMigration, resource?: Uri): Promise<void> {

		const configuration = workspace.getConfiguration(undefined, resource);
		const inspectData = configuration.inspect(migration.key);

		if (!inspectData) {
			return;
		}

		const targetPairs: [unknown, ConfigurationTarget][] = [
			[inspectData.globalValue, ConfigurationTarget.Global],
			[inspectData.workspaceValue, ConfigurationTarget.Workspace],
		];

		for (const [inspectValue, target] of targetPairs) {
			if (!inspectValue) {
				continue;
			}

			const migrationValues: [string, ConfigurationValue][] = [];

			if (inspectValue !== undefined) {
				const keyValuePairs = await this.runMigration(migration, inspectValue);
				for (const keyValuePair of keyValuePairs ?? []) {
					migrationValues.push(keyValuePair);
				}
			}

			if (migrationValues.length) {
				// apply migrations
				await Promise.allSettled(migrationValues.map(async ([key, value]) => {
					configuration.update(key, value.value, target);
				}));
			}
		}
	}

	private async runMigration(migration: ConfigurationMigration, value: any): Promise<ConfigurationKeyValuePairs | undefined> {
		const result = await migration.migrateFn(value);
		return Array.isArray(result) ? result : [[migration.key, result]];
	}

	private _register(disposable: IDisposable): void {
		this._disposables.add(disposable);
	}

	dispose(): void {
		this._disposables.dispose();
	}
}

ConfigurationMigrationRegistry.registerConfigurationMigrations([{
	key: 'github.copilot.chat.experimental.setupTests.enabled',
	migrateFn: async (value: any) => {
		return [
			['github.copilot.chat.setupTests.enabled', { value }],
			['github.copilot.chat.experimental.setupTests.enabled', { value: undefined }]
		];
	}
}]);

ConfigurationMigrationRegistry.registerConfigurationMigrations([{
	key: 'github.copilot.chat.experimental.codeGeneration.instructions',
	migrateFn: async (value: any) => {
		return [
			['github.copilot.chat.codeGeneration.instructions', { value }],
			['github.copilot.chat.experimental.codeGeneration.instructions', { value: undefined }]
		];
	}
}]);

ConfigurationMigrationRegistry.registerConfigurationMigrations([{
	key: 'github.copilot.chat.experimental.codeGeneration.useInstructionFiles',
	migrateFn: async (value: any) => {
		return [
			['github.copilot.chat.codeGeneration.useInstructionFiles', { value }],
			['github.copilot.chat.experimental.codeGeneration.useInstructionFiles', { value: undefined }]
		];
	}
}]);

ConfigurationMigrationRegistry.registerConfigurationMigrations([{
	key: 'github.copilot.chat.experimental.testGeneration.instructions',
	migrateFn: async (value: any) => {
		return [
			['github.copilot.chat.testGeneration.instructions', { value }],
			['github.copilot.chat.experimental.testGeneration.instructions', { value: undefined }]
		];
	}
}]);

ConfigurationMigrationRegistry.registerConfigurationMigrations([{
	key: 'github.copilot.chat.experimental.generateTests.codeLens',
	migrateFn: async (value: any) => {
		return [
			['github.copilot.chat.generateTests.codeLens', { value }],
			['github.copilot.chat.experimental.generateTests.codeLens', { value: undefined }]
		];
	}
}]);

ConfigurationMigrationRegistry.registerConfigurationMigrations([{
	key: 'github.copilot.chat.experimental.temporalContext.enabled',
	migrateFn: async (value: any) => {
		return [
			['github.copilot.chat.editor.temporalContext.enabled', { value }],
			['github.copilot.chat.experimental.temporalContext.enabled', { value: undefined }]
		];
	}
}]);

ConfigurationMigrationRegistry.registerConfigurationMigrations([{
	key: 'github.copilot.chat.temporalContext.enabled',
	migrateFn: async (value: any) => {
		return [
			['github.copilot.chat.editor.temporalContext.enabled', { value }],
			['github.copilot.chat.temporalContext.enabled', { value: undefined }]
		];
	}
}]);

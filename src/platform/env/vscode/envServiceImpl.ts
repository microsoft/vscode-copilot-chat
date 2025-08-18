/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { ExtensionMode } from 'vscode';
import { Platform, platform } from '../../../util/vs/base/common/platform';
import { env } from '../../../util/vs/base/common/process';
import { IEnvService, NameAndVersion, OperatingSystem } from '../common/envService';
import { isPreRelease, isProduction, packageJson } from '../common/packagejson';

export class EnvServiceImpl implements IEnvService {

	declare readonly _serviceBrand: undefined;

	constructor(private readonly extensionContext: vscode.ExtensionContext) {
	}

	public get extensionId(): string {
		return `${packageJson.publisher}.${packageJson.name}`.toLowerCase();
	}

	public get sessionId(): string {
		return vscode.env.sessionId;
	}
	public get machineId(): string {
		return vscode.env.machineId;
	}
	public get vscodeVersion(): string {
		return vscode.version;
	}
	public get remoteName(): string | undefined {
		return vscode.env.remoteName;
	}

	public get isActive(): boolean {
		return vscode.window.state.active;
	}

	public get OS(): OperatingSystem {
		switch (platform) {
			case Platform.Windows:
				return OperatingSystem.Windows;
			case Platform.Mac:
				return OperatingSystem.Macintosh;
			case Platform.Linux:
				return OperatingSystem.Linux;
			default:
				return OperatingSystem.Linux;
		}
	}

	get language() {
		return vscode.env.language;
	}

	get uriScheme(): string {
		return vscode.env.uriScheme;
	}

	get appRoot(): string {
		return vscode.env.appRoot;
	}

	get shell(): string {
		return vscode.env.shell;
	}

	isProduction(): boolean {
		return isProduction;
	}

	isPreRelease(): boolean {
		return isPreRelease;
	}

	isSimulation(): boolean {
		return false;
	}

	isScenarioAutomation(): boolean {
		return env['IS_SCENARIO_AUTOMATION'] === '1';
	}

	useRealUrlOpener(): boolean {
		return this.extensionContext.extensionMode !== vscode.ExtensionMode.Test || this.isScenarioAutomation();
	}

	showNotifications(): boolean {
		return this.extensionContext.extensionMode !== vscode.ExtensionMode.Test || this.isScenarioAutomation();
	}

	enableLanguageModels(): boolean {
		return this.extensionContext.extensionMode !== vscode.ExtensionMode.Test || this.isScenarioAutomation();
	}

	useProductionTelemetry(): boolean {
		return this.extensionContext.extensionMode !== vscode.ExtensionMode.Test && !this.isScenarioAutomation();
	}

	useExperimentationService(): boolean {
		return this.isProduction();
	}

	useProductionTokenManager(): boolean {
		return this.extensionContext.extensionMode !== vscode.ExtensionMode.Test && !this.isScenarioAutomation();
	}

	updateReviewContextValues(): boolean {
		return this.extensionContext.extensionMode !== vscode.ExtensionMode.Test || this.isScenarioAutomation();
	}

	enableLoggingActions(): boolean {
		return this.extensionContext.extensionMode !== vscode.ExtensionMode.Test || this.isScenarioAutomation();
	}

	activateExtension(force: boolean | undefined): boolean {
		return this.extensionContext.extensionMode === ExtensionMode.Test && !force && !this.isScenarioAutomation();
	}

	getBuildType(): 'prod' | 'dev' {
		return packageJson.buildType;
	}

	getVersion(): string {
		return packageJson.version;
	}

	getBuild(): string {
		return packageJson.build;
	}

	getName(): string {
		return packageJson.name;
	}

	getEditorInfo(): NameAndVersion {
		return new NameAndVersion('vscode', vscode.version);
	}
	getEditorPluginInfo(): NameAndVersion {
		return new NameAndVersion('copilot-chat', packageJson.version);
	}

	openExternal(target: vscode.Uri): Promise<boolean> {
		return new Promise((resolve, reject) => vscode.env.openExternal(target).then(resolve, reject));
	}
}

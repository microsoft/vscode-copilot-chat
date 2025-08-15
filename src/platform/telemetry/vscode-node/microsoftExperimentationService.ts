/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { getExperimentationService, IExperimentationFilterProvider, IExperimentationService as ITASExperimentationService, TargetPopulation } from 'vscode-tas-client';
import { RunOnceScheduler } from '../../../util/vs/base/common/async';
import { Emitter } from '../../../util/vs/base/common/event';
import { Disposable } from '../../../util/vs/base/common/lifecycle';
import { ICopilotTokenStore } from '../../authentication/common/copilotTokenStore';
import { IEnvService } from '../../env/common/envService';
import { IVSCodeExtensionContext } from '../../extContext/common/extensionContext';
import { IExperimentationService } from '../common/nullExperimentationService';
import { ITelemetryService } from '../common/telemetry';

class UserInfoStore extends Disposable {
	private _isInternal: boolean = false;
	private _sku: string | undefined;

	private _onDidChangeUserInfo = this._register(new Emitter<void>());
	readonly onDidChangeUserInfo = this._onDidChangeUserInfo.event;

	constructor(private readonly context: IVSCodeExtensionContext, copilotTokenStore: ICopilotTokenStore) {
		super();
		if (copilotTokenStore) {
			copilotTokenStore.onDidStoreUpdate(() => {
				this.updateUserInfo(copilotTokenStore.copilotToken?.isInternal ?? false, copilotTokenStore.copilotToken?.sku);
			});

			if (copilotTokenStore.copilotToken) {
				this.updateUserInfo(copilotTokenStore.copilotToken.isInternal, copilotTokenStore.copilotToken.sku);
			} else {
				const cachedInternalValue = this.context.globalState.get<boolean>('exp.github.internal') ?? false;
				const cachedSkuValue = this.context.globalState.get<string>('exp.github.copilot.sku');
				this.updateUserInfo(cachedInternalValue, cachedSkuValue);
			}
		}
	}

	get isInternal(): boolean {
		return this._isInternal;
	}

	get sku(): string | undefined {
		return this._sku;
	}

	private updateUserInfo(isInternal: boolean, sku?: string): void {
		if (this._isInternal === isInternal && this._sku === sku) {
			// no change
			return;
		}

		this._isInternal = isInternal;
		this._sku = sku;

		this.context.globalState.update('exp.github.internal', this._isInternal);
		this.context.globalState.update('exp.github.copilot.sku', this._sku);
	}
}

class GithubAccountFilterProvider implements IExperimentationFilterProvider {
	constructor(private _userInfoStore: UserInfoStore) { }

	getFilters(): Map<string, any> {
		const filters = new Map<string, any>();
		filters.set('X-GitHub-Copilot-SKU', this._userInfoStore.sku);
		filters.set('X-GitHub-Internal', this._userInfoStore.isInternal);
		return filters;
	}

}

function getTargetPopulation(isPreRelease: boolean): TargetPopulation {

	if (isPreRelease) {
		return TargetPopulation.Insiders;
	}

	return TargetPopulation.Public;
}

export class MicrosoftExperimentationService extends Disposable implements IExperimentationService {

	declare _serviceBrand: undefined;
	private readonly _delegate: ITASExperimentationService;
	private readonly _userInfoStore: UserInfoStore;

	private _onDidTreatmentsChange = this._register(new Emitter<void>());
	readonly onDidTreatmentsChange = this._onDidTreatmentsChange.event;

	constructor(
		@ITelemetryService telemetryService: ITelemetryService,
		@IVSCodeExtensionContext context: IVSCodeExtensionContext,
		@IEnvService envService: IEnvService,
		@ICopilotTokenStore copilotTokenStore: ICopilotTokenStore,
	) {
		super();

		const id = context.extension.id;
		const version = context.extension.packageJSON['version'];
		const targetPopulation = getTargetPopulation(envService.isPreRelease());
		this._userInfoStore = new UserInfoStore(context, copilotTokenStore);
		const userFilter = new GithubAccountFilterProvider(this._userInfoStore);

		// Refresh treatments when user info changes
		this._register(this._userInfoStore.onDidChangeUserInfo(async () => {
			await this._delegate.getTreatmentVariableAsync('vscode', 'refresh');
			this._onDidTreatmentsChange.fire();
		}));

		// Refresh treatments every hour
		this._register(new RunOnceScheduler(async () => {
			await this._delegate.getTreatmentVariableAsync('vscode', 'refresh');
			this._onDidTreatmentsChange.fire();
		}, 60 * 60 * 1000));

		this._delegate = getExperimentationService(
			id,
			version,
			targetPopulation,
			telemetryService,
			context.globalState,
			userFilter
		);
	}

	async hasTreatments(): Promise<void> {
		await this._delegate.initializePromise;
		return this._delegate.initialFetch;
	}

	getTreatmentVariable<T extends boolean | number | string>(configId: string, name: string): T | undefined {
		console.log('[ALERT!ExP] ExperimentationService: getTreatment', configId, name);

		return this._delegate.getTreatmentVariable(configId, name);
	}
}

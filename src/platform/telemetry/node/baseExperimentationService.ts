/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { IExperimentationService as ITASExperimentationService } from 'vscode-tas-client';
import { RunOnceScheduler } from '../../../util/vs/base/common/async';
import { Emitter } from '../../../util/vs/base/common/event';
import { Disposable } from '../../../util/vs/base/common/lifecycle';
import { ICopilotTokenStore } from '../../authentication/common/copilotTokenStore';
import { IVSCodeExtensionContext } from '../../extContext/common/extensionContext';
import { IExperimentationService } from '../common/nullExperimentationService';

export class UserInfoStore extends Disposable {
	private _internalOrg: string | undefined;
	private _sku: string | undefined;

	private _onDidChangeUserInfo = this._register(new Emitter<void>());
	readonly onDidChangeUserInfo = this._onDidChangeUserInfo.event;

	static INTERNAL_ORG_STORAGE_KEY = 'exp.github.copilot.internalOrg';
	static SKU_STORAGE_KEY = 'exp.github.copilot.sku';

	constructor(private readonly context: IVSCodeExtensionContext, copilotTokenStore: ICopilotTokenStore) {
		super();

		if (copilotTokenStore) {
			const getInternalOrg = (): string | undefined => {
				if (copilotTokenStore.copilotToken?.isGitHubInternal) {
					return 'github';
				} else if (copilotTokenStore.copilotToken?.isMicrosoftInternal) {
					return 'microsoft';
				}
				return undefined;
			};

			copilotTokenStore.onDidStoreUpdate(() => {
				this.updateUserInfo(getInternalOrg(), copilotTokenStore.copilotToken?.sku);
			});

			if (copilotTokenStore.copilotToken) {
				this.updateUserInfo(getInternalOrg(), copilotTokenStore.copilotToken.sku);
			} else {
				const cachedInternalValue = this.context.globalState.get<string>(UserInfoStore.INTERNAL_ORG_STORAGE_KEY);
				const cachedSkuValue = this.context.globalState.get<string>(UserInfoStore.SKU_STORAGE_KEY);
				this.updateUserInfo(cachedInternalValue, cachedSkuValue);
			}
		}
	}

	get internalOrg(): string | undefined {
		return this._internalOrg;
	}

	get sku(): string | undefined {
		return this._sku;
	}

	private updateUserInfo(internalOrg?: string, sku?: string): void {
		if (this._internalOrg === internalOrg && this._sku === sku) {
			// no change
			return;
		}

		this._internalOrg = internalOrg;
		this._sku = sku;

		this.context.globalState.update(UserInfoStore.INTERNAL_ORG_STORAGE_KEY, this._internalOrg);
		this.context.globalState.update(UserInfoStore.SKU_STORAGE_KEY, this._sku);

		this._onDidChangeUserInfo.fire();
	}
}

export type TASClientDelegateFn = (globalState: any, userInfoStore: UserInfoStore) => ITASExperimentationService;

export class BaseExperimentationService extends Disposable implements IExperimentationService {

	declare _serviceBrand: undefined;
	private readonly _delegate: ITASExperimentationService;
	protected readonly _userInfoStore: UserInfoStore;

	protected _onDidTreatmentsChange = this._register(new Emitter<void>());
	readonly onDidTreatmentsChange = this._onDidTreatmentsChange.event;


	constructor(
		delegateFn: TASClientDelegateFn,
		@IVSCodeExtensionContext context: IVSCodeExtensionContext,
		@ICopilotTokenStore copilotTokenStore: ICopilotTokenStore,
	) {
		super();


		this._userInfoStore = new UserInfoStore(context, copilotTokenStore);

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

		this._delegate = delegateFn(context.globalState, this._userInfoStore);
	}

	async hasTreatments(): Promise<void> {
		await this._delegate.initializePromise;
		return this._delegate.initialFetch;
	}

	getTreatmentVariable<T extends boolean | number | string>(configId: string, name: string): T | undefined {
		return this._delegate.getTreatmentVariable(configId, name);
	}
}

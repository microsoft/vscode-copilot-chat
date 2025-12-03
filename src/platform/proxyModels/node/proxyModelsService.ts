/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { CancellationToken } from '../../../util/vs/base/common/cancellation';
import { Emitter } from '../../../util/vs/base/common/event';
import { Disposable } from '../../../util/vs/base/common/lifecycle';
import { derivedWithCancellationToken, observableFromEvent, ObservablePromise } from '../../../util/vs/base/common/observable';
import { CopilotToken } from '../../authentication/common/copilotToken';
import { ICopilotTokenStore } from '../../authentication/common/copilotTokenStore';
import { ICAPIClientService } from '../../endpoint/common/capiClient';
import { WireTypes } from '../../inlineEdits/common/dataTypes/inlineEditsModelsTypes';
import { ILogService } from '../../log/common/logService';
import { IFetcherService, Response } from '../../networking/common/fetcherService';
import { IProxyModelsService } from '../common/proxyModelsService';

export class ProxyModelsService extends Disposable implements IProxyModelsService {
	readonly _serviceBrand: undefined;

	private readonly _onModelListUpdated = this._register(new Emitter<void>());
	public readonly onModelListUpdated = this._onModelListUpdated.event;

	private _models: WireTypes.ModelList.t | undefined;

	constructor(
		@ICopilotTokenStore private readonly _tokenStore: ICopilotTokenStore,
		@ICAPIClientService private readonly _capiClient: ICAPIClientService,
		@IFetcherService private readonly _fetchService: IFetcherService,
		@ILogService private readonly _logService: ILogService,
	) {
		super();

		const copilotTokenObs = observableFromEvent(this, this._tokenStore.onDidStoreUpdate, () => this._tokenStore.copilotToken);

		this._modelsObs = derivedWithCancellationToken((reader, token) => {
			const copilotToken = copilotTokenObs.read(reader);
			return new ObservablePromise(this._fetchLatestModels(copilotToken, token)).resolvedValue;
		}).flatten().recomputeInitiallyAndOnChange(this._store);

		Event.fromObservable
	}

	get models(): WireTypes.ModelList.t | undefined {
		return this._models;
	}

	get nesModels(): WireTypes.Model.t[] | undefined {
		return this._models?.models.filter(model => model.serviceType === 'NESChat');
	}

	get instantApplyModels(): WireTypes.Model.t[] | undefined {
		return this._models?.models.filter(model => model.serviceType === 'InstantApplyChat');
	}

	private async _fetchLatestModels(copilotToken: CopilotToken | undefined, token: CancellationToken): Promise<WireTypes.ModelList.t | undefined> {
		if (!copilotToken) {
			return undefined;
		}

		const url = `${this._capiClient.proxyBaseURL}/models`;

		let r: Response;
		try {
			const abortController = this._fetchService.makeAbortController();
			token.onCancellationRequested(() => abortController.abort());
			r = await this._fetchService.fetch(url, {
				headers: {
					'Authorization': `Bearer ${copilotToken.token}`,
				},
				method: 'GET',
				timeout: 10_000,
			});
		} catch (e) {
			this._logService.error('Failed to fetch model list', e);
			return;
		}

		if (!r.ok) {
			this._logService.error(`Failed to fetch model list: ${r.status} ${r.statusText}`);
			return;
		}

		try {
			const jsonData: unknown = await r.json();
			const validatedData = WireTypes.ModelList.validator.validate(jsonData);
			if (validatedData.error) {
				throw new Error(`Invalid /models response data: ${validatedData.error.message}`); // TODO@ulugbekna: add telemetry
			}
			return validatedData.content;
		} catch (e) {
			this._logService.error(e, 'Failed to process /models response');
			return;
		}
	}

}

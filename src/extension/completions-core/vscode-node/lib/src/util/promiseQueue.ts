/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { createDecorator } from '../../../../../../util/vs/platform/instantiation/common/instantiation';

export const ICompletionsPromiseQueueService = createDecorator<ICompletionsPromiseQueueService>('completionsPromiseQueueService');
export interface ICompletionsPromiseQueueService {
	_serviceBrand: undefined;

	register(promise: Promise<unknown>): void;
	flush(): Promise<void>;
}

export class PromiseQueue implements ICompletionsPromiseQueueService {
	_serviceBrand: undefined;

	protected promises = new Set<Promise<unknown>>();
	register(promise: Promise<unknown>) {
		this.promises.add(promise);
		void promise.finally(() => this.promises.delete(promise));
	}

	async flush() {
		await Promise.allSettled(this.promises);
	}
}

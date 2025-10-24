/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

export class PromiseQueue {
	protected promises = new Set<Promise<unknown>>();
	register(promise: Promise<unknown>) {
		this.promises.add(promise);
		void promise.finally(() => this.promises.delete(promise));
	}

	async flush() {
		await Promise.allSettled(this.promises);
	}
}

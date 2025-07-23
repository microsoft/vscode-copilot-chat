/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { createServiceIdentifier } from '../../../util/common/services';
import { ThinkingData, ThinkingDelta } from '../common/thinking';


export interface IThinkingDataService {
	readonly _serviceBrand: undefined;
	set(ref: string, data: ThinkingData): void;
	get(id: string): ThinkingData | undefined;
	clear(): void;
	update(index: number, delta: ThinkingDelta): void;
}
export const IThinkingDataService = createServiceIdentifier<IThinkingDataService>('IThinkingDataService');


export class ThinkingDataImpl implements IThinkingDataService {
	readonly _serviceBrand: undefined;
	private data: Map<string, ThinkingData> = new Map();

	constructor() { }

	public set(ref: string, data: ThinkingData): void {
		this.data.set(ref, data);
	}

	public get(id: string): ThinkingData | undefined {
		return Array.from(this.data.values()).find(d => d.id === id || d.metadata === id || (d.metadata && id.startsWith(d.metadata)));
	}

	public clear(): void {
		this.data.clear();
	}

	public update(index: number, delta: ThinkingDelta): void {
		// @karthiknadig: should not need this update function once we have this supported via LM thinking API
		const idx = index.toString();
		const data = this.data.get(idx);
		if (data) {
			if (delta.text) {
				data.text += delta.text;
			}
			if (delta.metadata) {
				data.metadata = delta.metadata;
			}
			if (delta.id) {
				data.id = delta.id;
			}
			if (data.metadata && data.id) {
				this.data.set(data.metadata, data);
				this.data.delete(idx);
			} else {
				this.data.set(idx, data);
			}
		} else {
			this.data.set(delta.id ?? idx, {
				id: delta.id ?? '',
				text: delta.text || '',
				metadata: delta.metadata
			});
		}
	}
}
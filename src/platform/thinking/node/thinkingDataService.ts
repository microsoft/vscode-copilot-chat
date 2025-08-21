/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { createServiceIdentifier } from '../../../util/common/services';
import { EncryptedThinkingDelta, isEncryptedThinkingDelta, ThinkingData, ThinkingDelta } from '../common/thinking';


export interface IThinkingDataService {
	readonly _serviceBrand: undefined;
	set(ref: string, data: ThinkingData): void;
	get(id: string | string[]): ThinkingData | undefined;
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

	public get(id: string | string[]): ThinkingData | undefined {
		if (Array.isArray(id)) {
			return id.map(i => this.data.get(i)).find(d => d !== undefined);
		}
		return Array.from(this.data.values()).find(d => d.id === id || d.metadata === id || (d.metadata && id.startsWith(d.metadata)));
	}

	public clear(): void {
		this.data.clear();
	}

	public update(index: number, delta: ThinkingDelta | EncryptedThinkingDelta): void {
		const idx = index.toString();
		if (isEncryptedThinkingDelta(delta)) {
			this.data.set(delta.id, {
				id: delta.id,
				text: '',
				encrypted: delta.encrypted
			});
		} else {
			const data = this.data.get(idx);
			if (data) {
				if (delta.text) {
					data.text += delta.text;
				}
				if (delta.metadata && delta.metadata.length > 0) {
					data.metadata = delta.metadata;
				}
				if (delta.id && delta.id.length > 0) {
					data.id = delta.id;
				}
				if (data.id && data.id.length > 0) {
					this.data.set(data.id, data);
					this.data.delete(idx);
				} else {
					this.data.set(idx, data);
				}
			} else if (delta.id && delta.id.length > 0) {
				this.data.set(delta.id, {
					id: delta.id,
					text: delta.text || '',
					metadata: delta.metadata
				});
			} else {
				this.data.set(idx, {
					id: '',
					text: delta.text || '',
					metadata: delta.metadata
				});
			}
		}
	}
}
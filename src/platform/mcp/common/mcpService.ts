/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { Event, McpServerDefinition } from 'vscode';
import { createServiceIdentifier } from '../../../util/common/services';
import { Emitter } from '../../../util/vs/base/common/event';
import { DisposableStore, IDisposable } from '../../../util/vs/base/common/lifecycle';

export const IMcpService = createServiceIdentifier<IMcpService>('IMcpService');

export interface IMcpService {
	readonly _serviceBrand: undefined;
	readonly mcpServerDefinitions: readonly McpServerDefinition[];
	readonly onDidChangeMcpServerDefinitions: Event<void>;

}

export abstract class AbstractMcpService implements IMcpService {
	declare readonly _serviceBrand: undefined;
	abstract readonly mcpServerDefinitions: readonly McpServerDefinition[];
	abstract readonly onDidChangeMcpServerDefinitions: Event<void>;
}

export class NullMcpService extends AbstractMcpService implements IDisposable {
	private readonly disposables = new DisposableStore();

	readonly mcpServerDefinitions: McpServerDefinition[] = [];
	readonly onDidChangeMcpServerDefinitions: Event<void> = this.disposables.add(new Emitter<void>()).event;
	public dispose() {
		this.disposables.dispose();
	}
}

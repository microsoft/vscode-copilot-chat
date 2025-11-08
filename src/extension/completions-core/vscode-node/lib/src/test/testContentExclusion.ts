/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { CopilotContentExclusionManager } from '../contentExclusion/contentExclusionManager';
import { ICompletionsContextService } from '../context';

export class AlwaysBlockingCopilotContentRestrictions extends CopilotContentExclusionManager {
	override evaluate() {
		return Promise.resolve({ isBlocked: true });
	}
}

export class NeverBlockCopilotContentExclusionManager extends CopilotContentExclusionManager {
	override evaluate() {
		return Promise.resolve({ isBlocked: false });
	}
}

export class BlockingContentExclusionManager extends CopilotContentExclusionManager {
	constructor(
		private readonly blockedUris: string[] = [],
		@ICompletionsContextService ctx: ICompletionsContextService,
	) {
		super(ctx);
	}

	override evaluate(uri: string) {
		if (this.blockedUris.includes(uri)) {
			return Promise.resolve({
				isBlocked: true,
			});
		}
		return Promise.resolve({
			isBlocked: false,
		});
	}
}

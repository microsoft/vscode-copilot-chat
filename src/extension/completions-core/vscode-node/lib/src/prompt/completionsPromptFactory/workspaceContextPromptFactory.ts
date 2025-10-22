/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Context } from '../../context';
import { CascadingPromptFactory } from './cascadingPromptFactory';
import {
	BasicPrefixComponent,
	CachedSuffixComponent,
	CodeSnippetComponent,
	ConcatenatedContextComponent,
	TraitComponent,
	VirtualPromptComponent,
} from '../components/virtualComponent';
import { WorkspaceContextPromptComponent } from '../workspaceContext';
import { PromptComponentId } from '../../../../prompt/src/prompt';

export class WorkspaceContextPromptFactory extends CascadingPromptFactory {
	constructor(ctx: Context) {
		const components: Record<PromptComponentId, VirtualPromptComponent> = {
			stableContext: new WorkspaceContextPromptComponent(ctx),
			prefix: new BasicPrefixComponent(),
			suffix: new CachedSuffixComponent(ctx),
			volatileContext: new ConcatenatedContextComponent('volatileContext', [
				new TraitComponent(),
				new CodeSnippetComponent(ctx),
			]),
		};
		super(ctx, components);
	}
}

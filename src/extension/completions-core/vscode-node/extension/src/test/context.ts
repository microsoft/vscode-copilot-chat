/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
import { createExtensionTestingServices } from '../../../../../test/vscode-node/services';
import { EditorAndPluginInfo } from '../../../lib/src/config';
import { CopilotContentExclusionManager } from '../../../lib/src/contentExclusion/contentExclusionManager';
import { FileSystem } from '../../../lib/src/fileSystem';
import { Fetcher } from '../../../lib/src/networking';
import { _createBaselineContext } from '../../../lib/src/test/context';
import { StaticFetcher } from '../../../lib/src/test/fetcher';
import { TestPromiseQueue } from '../../../lib/src/test/telemetry';
import { TextDocumentManager } from '../../../lib/src/textDocumentManager';
import { PromiseQueue } from '../../../lib/src/util/promiseQueue';
import { VSCodeEditorInfo } from '../config';
import { CopilotExtensionStatus } from '../extensionStatus';
import { extensionFileSystem } from '../fileSystem';
import { ExtensionTextDocumentManager } from '../textDocumentManager';
import { ExtensionTestConfigProvider } from './config';

/**
 * A default context for VSCode extension testing, building on general one in `lib`.
 * Only includes items that are needed for almost all extension tests.
 */
export function createExtensionTestingContext() {
	const services = createExtensionTestingServices();
	const accessor = services.createTestingAccessor();
	const ctx = _createBaselineContext(accessor, new ExtensionTestConfigProvider());
	ctx.set(Fetcher, new StaticFetcher());
	ctx.set(EditorAndPluginInfo, new VSCodeEditorInfo());
	ctx.set(TextDocumentManager, new ExtensionTextDocumentManager(ctx));
	ctx.set(FileSystem, extensionFileSystem);
	ctx.forceSet(PromiseQueue, new TestPromiseQueue());
	ctx.forceSet(CopilotContentExclusionManager, new CopilotContentExclusionManager(ctx));
	ctx.set(CopilotExtensionStatus, new CopilotExtensionStatus());
	return ctx;
}

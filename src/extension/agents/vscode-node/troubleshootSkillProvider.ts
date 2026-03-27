/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { IVSCodeExtensionContext } from '../../../platform/extContext/common/extensionContext';
import { ILogService } from '../../../platform/log/common/logService';
import { BaseSkillProvider } from './baseSkillProvider';

const RUNTIME_CONTEXT_PLACEHOLDER = '{{DEBUG_LOG_RUNTIME_CONTEXT}}';

export class TroubleshootSkillProvider extends BaseSkillProvider {

	constructor(
		@ILogService logService: ILogService,
		@IVSCodeExtensionContext extensionContext: IVSCodeExtensionContext,
	) {
		super(logService, extensionContext, 'troubleshoot');
	}

	private getRuntimeContext(): string {
		const lines: string[] = [];
		lines.push('## Runtime Log Context');
		lines.push('');

		// Provide the debug-logs directory path so the agent can find log files.
		// The {{CURRENT_SESSION_LOG}} placeholder may be resolved earlier during prompt
		// rendering (for example by PromptFile.getBodyContent) or later by the read_file
		// tool, which has access to the correct session context.
		const storageUri = this.extensionContext.storageUri;
		if (storageUri) {
			lines.push('- Session log directories: `{{CURRENT_SESSION_LOG}}`');
			lines.push('- If multiple directories are listed, compare the sessions to identify common issues and differences.');
		} else {
			lines.push('- Debug-logs directory: unavailable in this environment. Abort now and tell the user that troubleshooting is only available if a workspace is open.');
		}

		return lines.join('\n');
	}

	protected override processTemplate(templateContent: string): string {
		return templateContent.replace(RUNTIME_CONTEXT_PLACEHOLDER, this.getRuntimeContext());
	}
}

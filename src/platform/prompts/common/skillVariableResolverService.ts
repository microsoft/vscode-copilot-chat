/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { createServiceIdentifier } from '../../../util/common/services';
import { joinPath } from '../../../util/vs/base/common/resources';
import { IChatDebugFileLoggerService } from '../../chat/common/chatDebugFileLoggerService';
import { IPromptPathRepresentationService } from './promptPathRepresentationService';

export const ISkillVariableResolverService = createServiceIdentifier<ISkillVariableResolverService>('ISkillVariableResolverService');

/**
 * Known skill template variables that can be resolved at runtime.
 * Each entry maps a placeholder name (without the `{{ }}` delimiters) to a
 * resolver that produces the replacement string, or `undefined` if the
 * variable cannot be resolved in the current context.
 */
type VariableResolver = (sessionId: string | undefined) => string | undefined;

/**
 * Resolves well-known `{{VARIABLE}}` placeholders inside skill template
 * content.  All skills pass through this service so that placeholder
 * resolution is centralised rather than duplicated at each call-site.
 *
 * Currently supported variables:
 * - `CURRENT_SESSION_LOG` — path to the active session's debug-log directory.
 */
export interface ISkillVariableResolverService {
	readonly _serviceBrand: undefined;

	/**
	 * Replace all known `{{VARIABLE}}` placeholders in {@link content}.
	 *
	 * @param content  The raw template string.
	 * @param sessionId  The chat session ID used to resolve session-scoped
	 *   variables.  May be `undefined` when the session is not (yet) known;
	 *   in that case session-scoped variables are left unresolved.
	 * @returns The content with all resolvable placeholders replaced.
	 */
	resolveVariables(content: string, sessionId: string | undefined): string;
}

export class SkillVariableResolverService implements ISkillVariableResolverService {
	declare readonly _serviceBrand: undefined;

	private readonly _resolvers: ReadonlyMap<string, VariableResolver>;

	constructor(
		@IChatDebugFileLoggerService private readonly chatDebugFileLoggerService: IChatDebugFileLoggerService,
		@IPromptPathRepresentationService private readonly promptPathRepresentationService: IPromptPathRepresentationService,
	) {
		this._resolvers = new Map<string, VariableResolver>([
			['CURRENT_SESSION_LOG', sessionId => {
				if (!sessionId) {
					return undefined;
				}
				const logDir = this.chatDebugFileLoggerService.debugLogsDir;
				if (!logDir) {
					return undefined;
				}
				return this.promptPathRepresentationService.getFilePath(joinPath(logDir, sessionId));
			}],
		]);
	}

	resolveVariables(content: string, sessionId: string | undefined): string {
		for (const [name, resolve] of this._resolvers) {
			const placeholder = `{{${name}}}`;
			if (content.includes(placeholder)) {
				const value = resolve(sessionId);
				if (value !== undefined) {
					content = content.replaceAll(placeholder, () => value);
				}
			}
		}
		return content;
	}
}

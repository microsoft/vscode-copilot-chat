/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { PermissionMode } from '@anthropic-ai/claude-agent-sdk';
import { CapturingToken } from '../../../../platform/requestLogger/common/capturingToken';
import { createServiceIdentifier } from '../../../../util/common/services';
import { Emitter, Event } from '../../../../util/vs/base/common/event';
import { Disposable } from '../../../../util/vs/base/common/lifecycle';
import { IClaudeCodeModels } from './claudeCodeModels';

export interface SessionState {
	modelId: string | undefined;
	permissionMode: PermissionMode;
	capturingToken: CapturingToken | undefined;
}

/**
 * Event fired when session state changes.
 */
export interface SessionStateChangeEvent {
	readonly sessionId: string;
	readonly modelId?: string;
	readonly permissionMode?: PermissionMode;
}

export interface IClaudeSessionStateService {
	readonly _serviceBrand: undefined;

	/**
	 * Event fired when session state (model or permission mode) changes.
	 */
	readonly onDidChangeSessionState: Event<SessionStateChangeEvent>;

	/**
	 * Gets the model ID for a session. Falls back to default if not set.
	 */
	getModelIdForSession(sessionId: string): Promise<string | undefined>;

	/**
	 * Sets the model ID for a session.
	 */
	setModelIdForSession(sessionId: string, modelId: string | undefined): void;

	/**
	 * Gets the permission mode for a session.
	 */
	getPermissionModeForSession(sessionId: string): PermissionMode;

	/**
	 * Sets the permission mode for a session.
	 */
	setPermissionModeForSession(sessionId: string, mode: PermissionMode): void;

	/**
	 * Gets the capturing token for a session (used for request logging grouping).
	 */
	getCapturingTokenForSession(sessionId: string): CapturingToken | undefined;

	/**
	 * Sets the capturing token for a session.
	 */
	setCapturingTokenForSession(sessionId: string, token: CapturingToken | undefined): void;
}

export const IClaudeSessionStateService = createServiceIdentifier<IClaudeSessionStateService>('IClaudeSessionStateService');

export class ClaudeSessionStateService extends Disposable implements IClaudeSessionStateService {
	declare _serviceBrand: undefined;

	private readonly _onDidChangeSessionState = this._register(new Emitter<SessionStateChangeEvent>());
	readonly onDidChangeSessionState = this._onDidChangeSessionState.event;

	// State for sessions (model and permission mode selections)
	// TODO: What about expiration of state for old sessions?
	private readonly _sessionState = new Map<string, SessionState>();

	constructor(
		@IClaudeCodeModels private readonly claudeCodeModels: IClaudeCodeModels,
	) {
		super();
	}

	async getModelIdForSession(sessionId: string): Promise<string | undefined> {
		const state = this._sessionState.get(sessionId);
		if (state?.modelId !== undefined) {
			return state.modelId;
		}
		// Fall back to default
		return this.claudeCodeModels.getDefaultModel();
	}

	setModelIdForSession(sessionId: string, modelId: string | undefined): void {
		const existing = this._sessionState.get(sessionId);
		if (existing?.modelId === modelId) {
			return;
		}
		this._sessionState.set(sessionId, {
			modelId,
			permissionMode: existing?.permissionMode ?? 'acceptEdits',
			capturingToken: existing?.capturingToken
		});
		this._onDidChangeSessionState.fire({ sessionId, modelId });
	}

	getPermissionModeForSession(sessionId: string): PermissionMode {
		return this._sessionState.get(sessionId)?.permissionMode ?? 'acceptEdits';
	}

	setPermissionModeForSession(sessionId: string, mode: PermissionMode): void {
		const existing = this._sessionState.get(sessionId);
		if (existing?.permissionMode === mode) {
			return;
		}
		this._sessionState.set(sessionId, {
			modelId: existing?.modelId,
			permissionMode: mode,
			capturingToken: existing?.capturingToken
		});
		this._onDidChangeSessionState.fire({ sessionId, permissionMode: mode });
	}

	getCapturingTokenForSession(sessionId: string): CapturingToken | undefined {
		return this._sessionState.get(sessionId)?.capturingToken;
	}

	setCapturingTokenForSession(sessionId: string, token: CapturingToken | undefined): void {
		const existing = this._sessionState.get(sessionId);
		this._sessionState.set(sessionId, {
			modelId: existing?.modelId,
			permissionMode: existing?.permissionMode ?? 'acceptEdits',
			capturingToken: token
		});
	}

	override dispose(): void {
		this._sessionState.clear();
		super.dispose();
	}
}

/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { ConfigKey, IConfigurationService } from '../../configuration/common/configurationService';
import { IEnvService } from '../../env/common/envService';
import { ILogService } from '../../log/common/logService';
import { Disposable } from '../../../util/vs/base/common/lifecycle';
import { NullOpenTelemetryService } from '../common/nullOpenTelemetryService';
import {
	IAgentRunAttributes,
	IApiRequestAttributes,
	IApiResponseAttributes,
	IConfigAttributes,
	IFileOperationAttributes,
	IOpenTelemetryConfig,
	IOpenTelemetryService,
	ISpanContext,
	IToolCallAttributes,
	IUserPromptAttributes,
} from '../common/openTelemetryService';
import { FileOpenTelemetryService } from '../node/fileOpenTelemetryService';

/**
 * OpenTelemetry service implementation that delegates to either FileOpenTelemetryService
 * or NullOpenTelemetryService based on configuration.
 */
export class OpenTelemetryServiceImpl extends Disposable implements IOpenTelemetryService {
	declare readonly _serviceBrand: undefined;

	private _delegate: IOpenTelemetryService;

	constructor(
		@IConfigurationService private readonly _configurationService: IConfigurationService,
		@ILogService private readonly _logService: ILogService,
		@IEnvService private readonly _envService: IEnvService,
	) {
		super();

		// Read configuration and create appropriate delegate
		this._delegate = this._createDelegate();

		// Listen for configuration changes
		this._register(this._configurationService.onDidChangeConfiguration(e => {
			if (
				e.affectsConfiguration(ConfigKey.Advanced.OpenTelemetryEnabled.fullyQualifiedId) ||
				e.affectsConfiguration(ConfigKey.Advanced.OpenTelemetryOutfile.fullyQualifiedId) ||
				e.affectsConfiguration(ConfigKey.Advanced.OpenTelemetryLogPrompts.fullyQualifiedId) ||
				e.affectsConfiguration(ConfigKey.Advanced.OpenTelemetryOtlpEndpoint.fullyQualifiedId) ||
				e.affectsConfiguration(ConfigKey.Advanced.OpenTelemetryOtlpProtocol.fullyQualifiedId)
			) {
				this._recreateDelegate();
			}
		}));
	}

	private _readConfig(): IOpenTelemetryConfig {
		return {
			enabled: this._configurationService.getConfig(ConfigKey.Advanced.OpenTelemetryEnabled),
			target: this._configurationService.getConfig(ConfigKey.Advanced.OpenTelemetryTarget),
			otlpEndpoint: this._configurationService.getConfig(ConfigKey.Advanced.OpenTelemetryOtlpEndpoint),
			otlpProtocol: this._configurationService.getConfig(ConfigKey.Advanced.OpenTelemetryOtlpProtocol),
			outfile: this._configurationService.getConfig(ConfigKey.Advanced.OpenTelemetryOutfile),
			logPrompts: this._configurationService.getConfig(ConfigKey.Advanced.OpenTelemetryLogPrompts),
		};
	}

	private _createDelegate(): IOpenTelemetryService {
		const config = this._readConfig();

		if (!config.enabled) {
			this._logService.trace('[OpenTelemetry] Disabled via configuration');
			return new NullOpenTelemetryService();
		}

		this._logService.info(`[OpenTelemetry] Enabled. Target: ${config.target}, Outfile: ${config.outfile || 'none'}`);

		// Create the file-based service manually since it's not in DI
		// We need to create it without the DI decorators
		return new FileOpenTelemetryService(config, this._logService, this._envService);
	}

	private _recreateDelegate(): void {
		// Dispose the old delegate
		if ('dispose' in this._delegate && typeof this._delegate.dispose === 'function') {
			this._delegate.dispose();
		}

		// Create a new delegate based on current config
		this._delegate = this._createDelegate();
	}

	get isEnabled(): boolean {
		return this._delegate.isEnabled;
	}

	getConfig(): IOpenTelemetryConfig {
		return this._delegate.getConfig();
	}

	// ============== Log Events ==============

	logConfig(attributes: IConfigAttributes): void {
		this._delegate.logConfig(attributes);
	}

	logUserPrompt(attributes: IUserPromptAttributes): void {
		this._delegate.logUserPrompt(attributes);
	}

	logToolCall(attributes: IToolCallAttributes): void {
		this._delegate.logToolCall(attributes);
	}

	logApiRequest(attributes: IApiRequestAttributes): void {
		this._delegate.logApiRequest(attributes);
	}

	logApiResponse(attributes: IApiResponseAttributes): void {
		this._delegate.logApiResponse(attributes);
	}

	logApiError(attributes: IApiResponseAttributes & { error: string; error_type: string }): void {
		this._delegate.logApiError(attributes);
	}

	logAgentStart(attributes: Pick<IAgentRunAttributes, 'agent_id' | 'agent_name'>): void {
		this._delegate.logAgentStart(attributes);
	}

	logAgentFinish(attributes: IAgentRunAttributes): void {
		this._delegate.logAgentFinish(attributes);
	}

	logFileOperation(attributes: IFileOperationAttributes): void {
		this._delegate.logFileOperation(attributes);
	}

	logConversationFinished(attributes: { approvalMode?: string; turnCount: number }): void {
		this._delegate.logConversationFinished(attributes);
	}

	// ============== Metrics ==============

	incrementSessionCount(): void {
		this._delegate.incrementSessionCount();
	}

	recordToolCall(functionName: string, success: boolean, toolType: 'native' | 'mcp', durationMs?: number): void {
		this._delegate.recordToolCall(functionName, success, toolType, durationMs);
	}

	recordApiRequest(model: string, statusCode: number | string, durationMs: number, errorType?: string): void {
		this._delegate.recordApiRequest(model, statusCode, durationMs, errorType);
	}

	recordTokenUsage(model: string, tokenType: 'input' | 'output' | 'cache', count: number): void {
		this._delegate.recordTokenUsage(model, tokenType, count);
	}

	recordFileOperation(operation: 'create' | 'read' | 'update', lines?: number): void {
		this._delegate.recordFileOperation(operation, lines);
	}

	recordAgentRun(agentName: string, durationMs: number, turnCount: number, terminateReason: string): void {
		this._delegate.recordAgentRun(agentName, durationMs, turnCount, terminateReason);
	}

	// ============== Spans/Traces ==============

	startSessionSpan(sessionId: string): ISpanContext | undefined {
		return this._delegate.startSessionSpan(sessionId);
	}

	endSessionSpan(spanContext: ISpanContext | undefined): void {
		this._delegate.endSessionSpan(spanContext);
	}

	startApiRequestSpan(parentContext: ISpanContext | undefined, model: string, requestId: string): ISpanContext | undefined {
		return this._delegate.startApiRequestSpan(parentContext, model, requestId);
	}

	endApiRequestSpan(spanContext: ISpanContext | undefined, success: boolean, tokenUsage?: { input: number; output: number }): void {
		this._delegate.endApiRequestSpan(spanContext, success, tokenUsage);
	}

	startToolSpan(parentContext: ISpanContext | undefined, toolName: string): ISpanContext | undefined {
		return this._delegate.startToolSpan(parentContext, toolName);
	}

	endToolSpan(spanContext: ISpanContext | undefined, success: boolean, error?: string): void {
		this._delegate.endToolSpan(spanContext, success, error);
	}

	async flush(): Promise<void> {
		return this._delegate.flush();
	}

	override dispose(): void {
		if ('dispose' in this._delegate && typeof this._delegate.dispose === 'function') {
			this._delegate.dispose();
		}
		super.dispose();
	}
}

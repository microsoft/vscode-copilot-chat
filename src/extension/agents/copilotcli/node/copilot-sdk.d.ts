/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Type stubs for @github/copilot/sdk until package is installed
// Based on @sweagent/runtime/sdk structure

declare module '@github/copilot/sdk' {
	export interface RunnerLogger {
		isDebug(): boolean;
		debug(message: string): void;
		log(message: string): void;
		info(message: string): void;
		notice(message: string | Error): void;
		warning(message: string | Error): void;
		error(message: string | Error): void;
		startGroup(name: string, level?: LogLevel): void;
		endGroup(level?: LogLevel): void;
	}

	export enum LogLevel {
		Debug = "debug",
		Info = "info",
		Notice = "notice",
		Warning = "warning",
		Error = "error"
	}

	export interface ModelProvider {
		type: string;
		model?: string;
		apiKey?: string;
		baseUrl?: string;
	}

	export interface SessionMetadata {
		readonly id: string;
		readonly startTime: Date;
		readonly selectedModel?: string;
	}

	export interface Session extends SessionMetadata {
		getChatMessages(): Promise<any[]>;
		addChatMessage(message: any): Promise<void>;
		onAbort(): Promise<void>;
	}

	export interface SessionManager<TSession extends Session = Session> {
		createSession(): Promise<TSession>;
		getLastSession(): Promise<TSession>;
		getSession(id: string): Promise<TSession>;
		listSessions(): Promise<SessionMetadata[]>;
		saveSession(session: TSession): Promise<void>;
		deleteSession(session: TSession): Promise<void>;
	}

	export type PermissionRequest = {
		readonly kind: "shell" | "write";
		readonly intention: string;
		[key: string]: any;
	};

	export type PermissionRequestResult = {
		readonly behavior: "allow" | "deny";
		readonly message?: string;
		readonly persistForSession?: boolean;
	};

	export interface MCPServerConfig {
		command: string;
		args?: string[];
		env?: Record<string, string>;
	}

	export interface QueryHooks {
		preToolUse?: Array<(input: any) => Promise<any>>;
		postToolUse?: Array<(input: any) => Promise<any>>;
		userPromptSubmitted?: Array<(input: any) => Promise<any>>;
		sessionStart?: Array<(input: any) => Promise<any>>;
		sessionEnd?: Array<(input: any) => Promise<any>>;
		errorOccurred?: Array<(input: any) => Promise<any>>;
	}

	export interface AgentOptions {
		modelProvider: ModelProvider;
		session?: Session;
		abortController?: AbortController;
		allowedTools?: string[];
		disabledTools?: string[];
		requestPermission?: (permissionRequest: PermissionRequest) => Promise<PermissionRequestResult>;
		mcpServers?: Record<string, MCPServerConfig>;
		hooks?: QueryHooks;
		logger?: RunnerLogger;
		workingDirectory?: string;
		env?: Record<string, string>;
		additionalDirectories?: string[];
		integrationId?: string;
		hmac?: string;
	}

	export type ToolResultExpanded = {
		textResultForLlm: string;
		binaryResultForLlm?: Array<{
			data: string;
			mimeType: string;
			type: string;
		}>;
		resultType: "success" | "failure" | "rejected" | "denied";
		error?: string;
		toolTelemetry: {
			properties?: Record<string, string | undefined>;
			restrictedProperties?: Record<string, string | undefined>;
			metrics?: Record<string, number | undefined>;
		};
		sessionLog?: string;
	};

	export type SDKEvent = {
		type: "thinking";
		content: string;
	} | {
		type: "message";
		content: string;
		role: "assistant" | "user";
	} | {
		type: "tool_use";
		toolName: string;
		args: unknown;
		toolCallId?: string;
	} | {
		type: "tool_result";
		toolName: string;
		result: ToolResultExpanded;
		toolCallId?: string;
	} | {
		type: "error";
		error: Error;
	};

	export class Agent {
		static name: string;
		static description: string;

		constructor(options: AgentOptions);
		query(prompt: string): AsyncGenerator<SDKEvent>;
	}

	export class CopilotCLISession {
		readonly id: string;
		readonly startTime: Date;
		readonly selectedModel?: string;

		getChatMessages(): Promise<any[]>;
		addChatMessage(message: any): Promise<void>;
		onAbort(): Promise<void>;
		save(): Promise<void>;
	}

	export class CopilotCLISessionManager implements SessionManager<CopilotCLISession> {
		constructor(options?: { logger?: RunnerLogger });
		createSession(): Promise<CopilotCLISession>;
		getLastSession(): Promise<CopilotCLISession>;
		getSession(id: string): Promise<CopilotCLISession>;
		listSessions(): Promise<SessionMetadata[]>;
		saveSession(session: CopilotCLISession): Promise<void>;
		deleteSession(session: CopilotCLISession): Promise<void>;
	}

	export function query(options: AgentOptions & { prompt: string }): AsyncIterable<SDKEvent>;
}

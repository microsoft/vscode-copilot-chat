/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { ChildProcessWithoutNullStreams, execSync, spawn } from 'child_process';
import { IFileSystemService } from '../../../platform/filesystem/common/fileSystemService';
import { ILogService } from '../../../platform/log/common/logService';
import { Emitter, Event } from '../../../util/vs/base/common/event';
import { Disposable } from '../../../util/vs/base/common/lifecycle';
import { removeAnsiEscapeCodes } from '../../../util/vs/base/common/strings';
import { URI } from '../../../util/vs/base/common/uri';
import { LanguageModelServer } from './langModelServer';
import { IInstantiationService } from '../../../util/vs/platform/instantiation/common/instantiation';

/*
 * See codex-rs/core/src/protocol.rs and codex-rs/docs/protocol_v1.md
 */
// Submission Queue types
interface Submission {
	id: string;
	op: Op;
}

type Op =
	| ConfigureSessionOp
	| UserInputOp
	| InterruptOp
	| ExecApprovalOp
	| PatchApprovalOp
	| AddToHistoryOp
	| GetHistoryEntryRequestOp;

interface ConfigureSessionOp {
	type: 'configure_session';
	id?: string;
	provider?: {
		name: string;
		base_url: string;
		env_key?: string;
		env_key_instructions?: string;
		wire_api: string;
		query_params?: any;
	};
	model?: string;
	model_reasoning_effort?: string;
	model_reasoning_summary?: string;
	instructions?: string;
	approval_policy: AskForApproval;
	sandbox_policy?: { mode: string };
	disable_response_storage?: boolean;
	notify?: string[];
	cwd: string;
}

enum AskForApproval {
	Untrusted = 'untrusted',
	OnFailure = 'on-failure',
	Never = 'Never'
}

interface UserInputOp {
	type: 'user_input';
	id?: string;
	items: InputItem[];
}

interface InterruptOp {
	type: 'interrupt';
	id?: string;
}

interface ExecApprovalOp {
	type: 'exec_approval';
	id?: string;
	decision: ReviewDecision;
}

interface PatchApprovalOp {
	type: 'patch_approval';
	id?: string;
	decision: ReviewDecision;
}

interface AddToHistoryOp {
	type: 'add_to_history';
	id?: string;
	text: string;
}

interface GetHistoryEntryRequestOp {
	type: 'get_history_entry_request';
	id?: string;
	offset: number;
	log_id: number;
}

type InputItem =
	| { type: 'text'; text: string }
	| { type: 'image'; image_url: string }
	| { type: 'local_image'; path: string };

type ReviewDecision = 'approved' | 'approved_for_session' | 'denied' | 'abort';

// Event Queue types
interface CodexEvent {
	id: string;
	msg: EventMsg;
}

type EventMsg =
	| ErrorEvent
	| TaskStartedEvent
	| TaskCompleteEvent
	| TokenCountEvent
	| AgentMessageEvent
	| AgentReasoningEvent
	| SessionConfiguredEvent
	| McpToolCallBeginEvent
	| McpToolCallEndEvent
	| ExecCommandBeginEvent
	| ExecCommandEndEvent
	| ExecCommandOutputDeltaEvent
	| ExecApprovalRequestEvent
	| ApplyPatchApprovalRequestEvent
	| BackgroundEventEvent
	| PatchApplyBeginEvent
	| PatchApplyEndEvent
	| GetHistoryEntryResponseEvent;

interface ErrorEvent {
	type: 'error';
	message: string;
}

interface TaskStartedEvent {
	type: 'task_started';
}

interface TaskCompleteEvent {
	type: 'task_complete';
	last_agent_message?: string;
}

interface TokenCountEvent {
	type: 'token_count';
	input_tokens: number;
	cached_input_tokens?: number;
	output_tokens: number;
	reasoning_output_tokens?: number;
	total_tokens: number;
}

interface AgentMessageEvent {
	type: 'agent_message';
	message: string;
}

interface AgentReasoningEvent {
	type: 'agent_reasoning';
	text: string;
}

interface SessionConfiguredEvent {
	type: 'session_configured';
	session_id: string;
	model: string;
	history_log_id: number;
	history_entry_count: number;
}

interface McpToolCallBeginEvent {
	type: 'mcp_tool_call_begin';
	call_id: string;
	server: string;
	tool: string;
	arguments?: any;
}

interface McpToolCallEndEvent {
	type: 'mcp_tool_call_end';
	call_id: string;
	result: { success: boolean; content?: any; error?: string };
}

interface ExecCommandBeginEvent {
	type: 'exec_command_begin';
	call_id: string;
	command: string[];
	cwd: string;
}

interface ExecCommandEndEvent {
	type: 'exec_command_end';
	call_id: string;
	stdout: string;
	stderr: string;
	exit_code: number;
}

interface ExecCommandOutputDeltaEvent {
	type: 'exec_command_output_delta';
	call_id: string;
	stream: 'stdout' | 'stderr';
	chunk: number[];
}

interface ExecApprovalRequestEvent {
	type: 'exec_approval_request';
	command: string[];
	cwd: string;
	reason?: string;
}

interface ApplyPatchApprovalRequestEvent {
	type: 'apply_patch_approval_request';
	changes: Record<string, FileChange>;
	reason?: string;
	grant_root?: string;
}

interface BackgroundEventEvent {
	type: 'background_event';
	message: string;
}

interface PatchApplyBeginEvent {
	type: 'patch_apply_begin';
	call_id: string;
	auto_approved: boolean;
	changes: Record<string, FileChange>;
}

interface PatchApplyEndEvent {
	type: 'patch_apply_end';
	call_id: string;
	stdout: string;
	stderr: string;
	success: boolean;
}

interface GetHistoryEntryResponseEvent {
	type: 'get_history_entry_response';
	offset: number;
	log_id: number;
	entry?: any;
}

type FileChange =
	| { type: 'add'; content: string }
	| { type: 'delete' }
	| { type: 'update'; unified_diff: string; move_path?: string };

/**
 * Codex Protocol Client
 * Manages communication with the Codex process via stdin/stdout
 */
export class CodexClient extends Disposable {
	private _proc: ChildProcessWithoutNullStreams | undefined;
	private _nextSubmissionId = 1;

	// Single event emitter for all Codex events
	private readonly _onEvent = this._register(new Emitter<CodexEvent>());

	// Public event accessor
	readonly onEvent: Event<CodexEvent> = this._onEvent.event;

	/**
	 * Example usage:
	 *
	 * client.onEvent(event => {
	 *   switch (event.type) {
	 *     case 'agent_message':
	 *       console.log('Agent says:', event.message);
	 *       break;
	 *     case 'exec_approval_request':
	 *       client.sendExecApproval('approved');
	 *       break;
	 *     case 'error':
	 *       console.error('Error:', event.message);
	 *       break;
	 *   }
	 * });
	 */

	constructor(
		@ILogService private readonly logService: ILogService,
		@IFileSystemService private readonly fileSystemService: IFileSystemService,
		@IInstantiationService private readonly instantiationService: IInstantiationService
	) {
		super();
	}

	/**
	 * Start the Codex process and configure the session
	 */
	async start(cwd: string): Promise<void> {
		if (this._proc) {
			throw new Error('Codex process already started');
		}

		const target = 'codex';
		// const target = '/Users/roblou/code/codex/codex-rs/target/debug/codex';
		const codexHome = '/tmp/vscode-codex';
		await this.fileSystemService.createDirectory(URI.file(codexHome));

		const lmServer = this.instantiationService.createInstance(LanguageModelServer);
		await lmServer.start();
		const lmServerConfig = lmServer.getConfig();

		const config = `
model = "gpt-4.1"
model_provider = "capi"

[model_providers.capi]
name = "CAPI"
base_url = "http://localhost:${lmServerConfig.port}/v1"
http_headers = { "X-Nonce" = "vscode-nonce" }
wire_api = "chat"`.trim();
		await this.fileSystemService.writeFile(URI.file(`${codexHome}/config.toml`), Buffer.from(config));

		this.logService.info(`Spawning Codex: ${target}`);

		// Verify codex version is >= 0.6.0
		await this.assertCodexGoodVersion();

		this._proc = spawn(target, ['proto'], {
			stdio: ['pipe', 'pipe', 'pipe'],
			env: {
				...process.env,
				RUST_LOG: 'trace',
				CODEX_HOME: codexHome
			},
			cwd
		});

		this._proc.stdout?.setEncoding('utf8');
		this._proc.stdout?.on('data', (data: string) => this._handleProcessOutput(data));
		this._proc.stderr?.on('data', (data: Buffer) => {
			this.logService.info(`Codex stderr: ${removeAnsiEscapeCodes(data.toString())}`);
		});

		this._proc.on('exit', (code: any) => {
			console.log('codex proto exited with code', code);
			this._proc = undefined;
		});

		// Configure session
		await this._sendSubmission({
			type: 'configure_session',
			// provider: {
			// 	name: 'capi',
			// 	// base_url: 'https://api.openai.com/v1',
			// 	// base_url: `http://localhost:${lmServerConfig.port}/v1`,
			// 	// env_key: 'OPENAI_API_KEY',
			// 	// env_key_instructions: 'Create an API key (https://platform.openai.com) and export it as an environment variable.',
			// 	// wire_api: 'responses',
			// 	wire_api: 'chat',
			// } as any,
			// model: 'codex-mini-latest',
			model: 'gpt-4.1',
			model_reasoning_effort: 'none',
			model_reasoning_summary: 'none',
			approval_policy: AskForApproval.Untrusted,
			sandbox_policy: { mode: 'workspace-write' },
			cwd
		});
		// await this._sendSubmission({
		// 	type: 'configure_session',
		// 	cwd,
		// 	approval_policy: AskForApproval.Never,
		// });
	}

	private async assertCodexGoodVersion(): Promise<void> {
		try {
			const result = execSync('codex --version', { encoding: 'utf8' });
			const output = removeAnsiEscapeCodes(result.toString()).trim();

			// Earlier versions don't support http_headers in config file, we need this.
			// Need native cli, which includes codex-cli in version output.
			const versionMatch = output.match(/codex-cli\s+(\d+)\.(\d+)\.(\d+)/);
			if (!versionMatch) {
				throw new Error(`Unexpected codex version output: ${output}`);
			}

			const [, major, minor, patch] = versionMatch.map(Number);
			const version = { major, minor, patch };

			if (version.major > 0 || (version.major === 0 && version.minor >= 6)) {
				this.logService.info(`Codex version check passed: ${output}`);
			} else {
				throw new Error(`Codex version ${major}.${minor}.${patch} is too old. Required: >= 0.6.0`);
			}
		} catch (error) {
			this.logService.error(`Codex version check failed: ${error}`);
			throw new Error(`Failed to verify codex version: ${error instanceof Error ? error.message : String(error)}`);
		}
	}

	/**
	 * Send user input to Codex
	 */
	async sendUserInput(text: string): Promise<void> {
		await this._sendSubmission({
			type: 'user_input',
			items: [{ type: 'text', text }]
		});
	}

	/**
	 * Interrupt the current task
	 */
	async interrupt(): Promise<void> {
		await this._sendSubmission({
			type: 'interrupt'
		});
	}

	/**
	 * Send approval decision for command execution
	 */
	async sendExecApproval(decision: ReviewDecision, requestId?: string): Promise<void> {
		await this._sendSubmission({
			type: 'exec_approval',
			decision,
			id: requestId
		});
	}

	/**
	 * Send approval decision for patch application
	 */
	async sendPatchApproval(decision: ReviewDecision, requestId?: string): Promise<void> {
		await this._sendSubmission({
			type: 'patch_approval',
			decision,
			id: requestId
		});
	}

	/**
	 * Stop the Codex process
	 */
	stop(): void {
		if (this._proc) {
			this._proc.kill();
			this._proc = undefined;
		}
	}

	override dispose(): void {
		this.stop();
		super.dispose();
	}

	private async _sendSubmission(op: Op): Promise<void> {
		if (!this._proc?.stdin) {
			throw new Error('Codex process not started');
		}

		const submissionId = (this._nextSubmissionId++).toString();
		const submission: Submission = {
			id: submissionId,
			op: {
				...op,
				id: op.id || submissionId
			} as Op
		};

		this._writeJsonLine(submission);
	}

	private _writeJsonLine(obj: any): void {
		if (!this._proc?.stdin) {
			return;
		}
		const str = JSON.stringify(obj);
		this.logService.info(`Sending to Codex: ${str}`);
		this._proc.stdin.write(str + '\n');
	}

	private _handleProcessOutput(data: string): void {
		for (const line of data.split(/\r?\n/)) {
			if (!line.trim()) {
				continue;
			}

			try {
				const event = JSON.parse(line) as CodexEvent;
				this._handleEvent(event);
			} catch (e) {
				console.error('Failed to parse event:', line, e);
			}
		}
	}

	private _handleEvent(event: CodexEvent): void {
		this.logService.info(`Got Codex event: ${JSON.stringify(event)}`);

		// Fire the single event with the message
		this._onEvent.fire(event);
	}
}

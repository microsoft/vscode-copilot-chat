/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
import {
	Handles,
	InitializedEvent,
	LoggingDebugSession,
	Scope,
	Source,
	StackFrame,
	StoppedEvent,
	TerminatedEvent,
	Thread
} from '@vscode/debugadapter';
import type { DebugProtocol } from '@vscode/debugprotocol';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { commands, type WorkspaceFolder } from 'vscode';
import { ChatReplayResponses, ChatStep } from '../common/chatReplayResponses';
import { parseReplay } from '../node/replayParser';

interface launchArgs extends DebugProtocol.LaunchRequestArguments { stopOnEntry: boolean; program: string }

export class ChatReplayDebugSession extends LoggingDebugSession {

	private static THREAD_ID = 1;

	private _workspaceFolder: WorkspaceFolder | undefined;
	private _program: string = '';
	private _chatSteps: ChatStep[] = [];
	private _currentIndex = -1;
	private _stopOnEntry = true;
	private _variableHandles = new Handles<{ step: ChatStep }>();
	private _replay = ChatReplayResponses.getInstance();

	constructor(workspaceFolder: WorkspaceFolder | undefined) {
		super();
		this._workspaceFolder = workspaceFolder;
		// all line/column numbers are 1-based in DAP
		this.setDebuggerLinesStartAt1(true);
		this.setDebuggerColumnsStartAt1(true);
	}

	// Initialize capabilities and signal ready to accept configuration (e.g., breakpoints)
	protected override initializeRequest(response: DebugProtocol.InitializeResponse, args: DebugProtocol.InitializeRequestArguments): void {
		response.body = response.body || {};
		response.body.supportsConfigurationDoneRequest = false;
		response.body.supportsStepBack = false;
		response.body.supportsEvaluateForHovers = false;
		this.sendResponse(response);
		this.sendEvent(new InitializedEvent());
	}

	// Launch the session: read and parse the markdown file and stop on the first header if requested
	protected override async launchRequest(response: DebugProtocol.LaunchResponse, args: launchArgs): Promise<void> {
		try {
			this._stopOnEntry = !!args.stopOnEntry;
			const programArg: string = args.program;
			if (!programArg || typeof programArg !== 'string') {
				return this.sendErrorResponse(response, 3001, 'Missing program (markdown file)');
			}

			// Resolve to absolute path; VS Code typically passes absolute already
			this._program = path.isAbsolute(programArg)
				? programArg
				: path.join(this._workspaceFolder?.uri.fsPath || process.cwd(), programArg);

			const content = fs.readFileSync(this._program, 'utf8');
			this._chatSteps = parseReplay(content);

			this.sendResponse(response);

			if (this._chatSteps.length === 0) {
				// Nothing to debug; terminate immediately
				this.sendEvent(new TerminatedEvent());
				return;
			}

			this._currentIndex = 0;
			this._replay = ChatReplayResponses.create(() => this.sendEvent(new TerminatedEvent()));
			startReplayInChat();

			if (this._stopOnEntry) {
				this.sendEvent(new StoppedEvent('entry', ChatReplayDebugSession.THREAD_ID));
			}
		} catch (err) {
			this.sendErrorResponse(response, 3002, `Failed to launch: ${err?.message || String(err)}`);
		}
	}

	protected override disconnectRequest(response: DebugProtocol.DisconnectResponse): void {
		this._replay.markDone();
		this.sendResponse(response);
		this.sendEvent(new TerminatedEvent());
	}

	protected override threadsRequest(response: DebugProtocol.ThreadsResponse): void {
		response.body = {
			threads: [new Thread(ChatReplayDebugSession.THREAD_ID, 'Main Thread')]
		};
		this.sendResponse(response);
	}

	protected override stackTraceRequest(response: DebugProtocol.StackTraceResponse, args: DebugProtocol.StackTraceArguments): void {
		const frames: StackFrame[] = [];
		const step = this.currentStep();
		if (step) {
			const source = new Source(path.basename(this._program), this._program);
			frames.push(new StackFrame(1, `#${step.kind} ${step.kind === 'userQuery' ? step.query : step.id}`, source, step.line, 1));
		}
		response.body = {
			stackFrames: frames,
			totalFrames: frames.length
		};
		this.sendResponse(response);
	}

	protected override scopesRequest(response: DebugProtocol.ScopesResponse, args: DebugProtocol.ScopesArguments): void {
		const step = this.currentStep();
		if (!step) {
			response.body = { scopes: [] };
			this.sendResponse(response);
			return;
		}
		const ref = this._variableHandles.create({ step });
		response.body = {
			scopes: [new Scope('Step', ref, false)]
		};
		this.sendResponse(response);
	}

	protected override variablesRequest(response: DebugProtocol.VariablesResponse, args: DebugProtocol.VariablesArguments): void {
		response.body = { variables: [] };
		this.sendResponse(response);
	}

	protected override setBreakPointsRequest(response: DebugProtocol.SetBreakpointsResponse, args: DebugProtocol.SetBreakpointsArguments): void {
		// We don't support user breakpoints; we stop automatically at headers
		response.body = {
			breakpoints: (args.breakpoints || []).map(bp => ({ verified: false, line: bp.line }))
		};
		this.sendResponse(response);
	}

	protected override continueRequest(response: DebugProtocol.ContinueResponse, args: DebugProtocol.ContinueArguments): void {
		const step = this.currentStep();
		if (step) {
			this.replayNextResponse(step);
			this.sendResponse(response);
		} else {
			// We're done
			this._replay.markDone();
			this.sendResponse(response);
			this.sendEvent(new TerminatedEvent());
		}
	}

	protected override nextRequest(response: DebugProtocol.NextResponse, args: DebugProtocol.NextArguments): void {
		const step = this.currentStep();
		if (step) {
			this.replayNextResponse(step);
			this.sendResponse(response);
		} else {
			this._replay.markDone();
			this.sendResponse(response);
			this.sendEvent(new TerminatedEvent());
		}
	}

	private replayNextResponse(step: ChatStep): void {
		this._replay.replayResponse(step);
		this._currentIndex++;

		// Send a stopped event to indicate we are at the next step
		this.sendEvent(new StoppedEvent('next', ChatReplayDebugSession.THREAD_ID));
	}

	protected override pauseRequest(response: DebugProtocol.PauseResponse, args: DebugProtocol.PauseArguments): void {
		// Stay on current header and report stopped
		this.sendResponse(response);
		this.sendEvent(new StoppedEvent('pause', ChatReplayDebugSession.THREAD_ID));
	}

	private currentStep(): ChatStep | undefined {
		if (this._currentIndex >= 0 && this._currentIndex < this._chatSteps.length) {
			return this._chatSteps[this._currentIndex];
		}

		this._currentIndex++;
		return undefined;
	}
}

async function startReplayInChat() {
	await commands.executeCommand('workbench.panel.chat.view.copilot.focus');
	await commands.executeCommand('type', {
		text: `\@chatReplay`,
	});
	await commands.executeCommand('workbench.action.chat.submit');
}

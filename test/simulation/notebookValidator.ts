/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as wireProtocol from '@nteract/messaging/lib/wire-protocol';
import { ChildProcessWithoutNullStreams, spawn } from 'child_process';
import * as crypto from 'crypto';
import { randomBytes } from 'crypto';
import { promises as fs } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import type * as vscode from 'vscode';
import type { Dealer, Push, Socket, Subscriber } from 'zeromq';
import { ITestingServicesAccessor } from '../../src/platform/test/node/services';
import { createSha256Hash } from '../../src/util/common/crypto';
import { ExtHostNotebookDocumentData, translateDisplayDataOutput, translateErrorOutput, translateStreamOutput } from '../../src/util/common/test/shims/notebookDocument';
import { IDisposable } from '../../src/util/vs/base/common/lifecycle';
import { findFreePortFaster } from '../../src/util/vs/base/node/ports';
import { NotebookRange } from '../../src/util/vs/workbench/api/common/extHostTypes/notebooks';
import { TestingCacheSalts } from '../base/salts';
import { CacheScope, ICachingResourceFetcher } from '../base/simulationContext';
import { NOTEBOOK_CELL_VALID_CACHE_SALT } from '../cacheSalt';
import { ensurePythonVEnv } from './diagnosticProviders/python';

type ResolvedMap<T> = { [K in keyof T]: T[K] extends PromiseLike<infer U> ? U : T[K] };

export const promiseMap = async <T extends { [key: string]: unknown }>(
	obj: T,
): Promise<ResolvedMap<T>> => {
	const out: Partial<ResolvedMap<T>> = {};
	await Promise.all(
		Object.keys(obj).map(async key => ((out as { [key: string]: unknown })[key] = await obj[key])),
	);
	return out as ResolvedMap<T>;
};

type Listener = (...args: any[]) => void;

export class EventEmitter {
	private listeners: Map<string, Listener[]>;

	constructor() {
		this.listeners = new Map();
	}

	on(event: string, listener: Listener): void {
		if (!this.listeners.has(event)) {
			this.listeners.set(event, []);
		}

		const listeners = this.listeners.get(event);
		listeners?.push(listener);
	}

	off(event: string, listener: Listener): void {
		const listeners = this.listeners.get(event);
		if (!listeners) {
			return;
		}

		const index = listeners.indexOf(listener);
		if (index > -1) {
			listeners.splice(index, 1);
		}
	}

	emit(event: string, ...args: any[]): void {
		const listeners = this.listeners.get(event);
		if (!listeners) {
			return;
		}

		listeners.forEach(listener => {
			listener(...args);
		});
	}
}

interface ISockets {
	key: string;
	signatureScheme: string;
	heartbeat: { port: number; socket: Push };
	control: { port: number; socket: Dealer };
	shell: { port: number; socket: Dealer };
	stdin: { port: number; socket: Dealer };
	iopub: { port: number; socket: Subscriber };
}

type SendChannel = 'control' | 'shell' | 'stdin';
type ReceiveChannel = 'control' | 'shell' | 'stdin' | 'iopub';

export type IOChannel = SendChannel | ReceiveChannel;

export declare type OriginalMessageType = "execute_request" | "inspect_request" | "inspect_reply" | "kernel_info_request" | "kernel_info_reply" | "complete_request" | "history_request" | "history_reply" | "is_complete_request" | "comm_info_request" | "comm_info_reply" | "shutdown_request" | "shutdown_reply" | "shell" | "display_data" | "stream" | "update_display_data" | "execute_input" | "execute_result" | "error" | "status" | "clear_output" | "iopub" | "input_request" | "input_reply" | "stdin" | "comm_open" | "comm_msg" | "comm_close" | "complete_reply" | "is_complete_reply" | "execute_reply" | "interrupt_request" | "interrupt_reply";

const fromRawMessage = <MT extends OriginalMessageType, C = unknown>(
	channel: IOChannel,
	rawMessage: OriginalRawJupyterMessage<MT, C>,
): TypedJupyerMessage => {
	return (({
		...rawMessage,
		channel,
		buffers: rawMessage.buffers ? Buffer.concat(rawMessage.buffers) : undefined,
	} as unknown) as TypedJupyerMessage);
};

const toRawMessage = (rawMessage: TypedJupyerMessage): OriginalRawJupyterMessage => {
	return {
		...rawMessage,
		header: rawMessage.header as JupyterMessageHeader<never>,
		parent_header: rawMessage.parent_header as JupyterMessageHeader<OriginalMessageType>,
		buffers: rawMessage.buffers ? rawMessage.buffers.map(buf => buf instanceof ArrayBuffer ? Buffer.from(buf) : Buffer.from(buf.buffer)) : [],
		idents: [],
	};
};

export function getZeroMQ(): typeof import('zeromq') {
	try {
		const zmq = require(`${'zeromq'}`);
		return zmq;
	} catch (e) {
		throw e;
	}
}

const portPool = new Set();
let lastUsedPort = 3000;
async function createSocket<T extends Socket>(socket: T): Promise<{ socket: T; port: number }> {
	const port = await findFreePortFasterWithQueue();
	socket.connect(`tcp://127.0.0.1:${port}`);
	return { port, socket };
}

const portQueue: { resolve: (value: number) => void; reject: (error: any) => void }[] = [];

async function findFreePortFasterWithQueue() {
	return new Promise((resolve: (port: number) => void, reject) => {
		portQueue.push({ resolve, reject });
		if (portQueue.length === 1) {
			processPortQueue();
		}
	});
}

async function processPortQueue() {
	while (portQueue.length > 0) {
		const { resolve, reject } = portQueue.shift()!;
		try {
			const startPort = lastUsedPort + 1;
			portPool.add(startPort);
			let port = await findFreePortFaster(startPort, 10000, 3000);
			while (portPool.has(port)) {
				port = await findFreePortFaster(port + 1, 10000, 3000);
			}

			portPool.add(port);
			lastUsedPort = port;
			resolve(port);
		} catch (error) {
			reject(error);
		}
	}
}

export class Connection implements IDisposable {
	public readonly messages: TypedJupyerMessage[] = [];
	private readonly _messageEventEmitter = new EventEmitter();

	public static async create() {
		const zmq = getZeroMQ();
		const routingId = crypto.randomBytes(8).toString('hex');
		const sockets: ISockets = await promiseMap({
			key: crypto.randomBytes(32).toString('hex'),
			signatureScheme: 'hmac-sha256',
			control: createSocket(new zmq.Dealer({ routingId })),
			heartbeat: createSocket(new zmq.Push()),
			iopub: createSocket(new zmq.Subscriber()),
			shell: createSocket(new zmq.Dealer({ routingId })),
			stdin: createSocket(new zmq.Dealer({ routingId })),
		});

		sockets.iopub.socket.subscribe();

		const cnx = new Connection(sockets, await createConnectionFile(sockets));
		cnx.processSocketMessages('control', sockets.control.socket);
		cnx.processSocketMessages('iopub', sockets.iopub.socket);
		cnx.processSocketMessages('shell', sockets.shell.socket);
		cnx.processSocketMessages('stdin', sockets.stdin.socket);
		return cnx;
	}

	protected constructor(
		private readonly sockets: ISockets,
		public readonly connectionFile: string,
	) {
	}

	private async processSocketMessages(
		channel: ReceiveChannel,
		socket: Dealer | Subscriber,
	) {
		for await (const msg of socket) {
			const message = wireProtocol.decode(msg, this.sockets.key, this.sockets.signatureScheme);
			const m = fromRawMessage(channel, message);
			this.messages.push(m);
			this._messageEventEmitter.emit('message', m);
		}
	}

	public sendAndReceive(message: TypedJupyerMessage): Promise<TypedJupyerMessage[]> {
		return new Promise<TypedJupyerMessage[]>((resolve, reject) => {
			const replyMessages: TypedJupyerMessage[] = [];
			const messageListener = (msg: TypedJupyerMessage) => {
				if (msg.parent_header?.msg_id === message.header.msg_id) {
					replyMessages.push(msg);

					if (msg.header.msg_type === 'execute_reply') {
						resolve(replyMessages);
					}
				}
			};

			this._messageEventEmitter.on('message', messageListener);
			const data = wireProtocol.encode(
				toRawMessage(message) as Partial<OriginalRawJupyterMessage<OriginalMessageType, any>>,
				this.sockets.key,
				this.sockets.signatureScheme,
			);
			this.sockets[message.channel as SendChannel].socket.send(data);
		});
	}

	public sendRaw(message: TypedJupyerMessage) {
		const data = wireProtocol.encode(
			toRawMessage(message) as Partial<OriginalRawJupyterMessage<OriginalMessageType, any>>,
			this.sockets.key,
			this.sockets.signatureScheme,
		);
		return this.sockets[message.channel as SendChannel].socket.send(data);
	}

	public dispose() {
		this.sockets.control.socket.close();
		this.sockets.heartbeat.socket.close();
		this.sockets.iopub.socket.close();
		this.sockets.shell.socket.close();
		this.sockets.stdin.socket.close();

		portPool.delete(this.sockets.control.port);
		portPool.delete(this.sockets.heartbeat.port);
		portPool.delete(this.sockets.iopub.port);
		portPool.delete(this.sockets.shell.port);
		portPool.delete(this.sockets.stdin.port);

		fs.unlink(this.connectionFile).catch(() => {
			/* it's a temp file, just ignore */
		});
	}
}

async function createConnectionFile(sockets: ISockets, host = '127.0.0.1'): Promise<string> {
	const contents = JSON.stringify({
		control_port: sockets.control.port,
		shell_port: sockets.shell.port,
		hb_port: sockets.heartbeat.port,
		stdin_port: sockets.stdin.port,
		iopub_port: sockets.iopub.port,
		transport: 'tcp',
		ip: host,
		signature_scheme: sockets.signatureScheme,
		key: sockets.key,
	});

	const fname = join(tmpdir(), `notebook-cnf-${crypto.randomBytes(8).toString('hex')}.json`);
	await fs.writeFile(fname, contents);
	return fname;
}

//#region jupyter-augments

export type MessageType = OriginalMessageType | 'debug_request' | 'debug_reply' | 'debug_event';

export interface OriginalRawJupyterMessage<MT extends MessageType = MessageType, C = any> {
	header: JupyterMessageHeader<MT>;
	parent_header: JupyterMessageHeader<any>;
	metadata: object;
	content: C;
	buffers: Array<Buffer>;
	idents: Array<Buffer>;
}

export interface OriginalJupyterMessageHeader<MT extends MessageType = MessageType> {
	msg_id: string;
	username: string;
	date: string;
	msg_type: MT;
	version: string;
	session: string;
}

export type JupyterMessageHeader<MT extends MessageType> = Omit<
	OriginalJupyterMessageHeader,
	'msg_type'
> & {
	msg_type: MT;
};

export interface OriginalJupyterMessage<MT extends MessageType = MessageType, C = any> {
	header: OriginalJupyterMessageHeader<MT>;
	parent_header: OriginalJupyterMessageHeader<any> | {
		msg_id?: string;
	};
	metadata: object;
	content: C;
	channel: string;
	buffers?: (ArrayBuffer | ArrayBufferView)[] | null;
}

export type JupyterMessage<
	MT extends MessageType = MessageType,
	C = unknown,
	Channel = IOChannel
> = Omit<OriginalJupyterMessage<never, C>, 'header' | 'channel'> & {
	header: JupyterMessageHeader<MT>;
	channel: Channel;
};

/**
 * @see https://jupyter-client.readthedocs.io/en/stable/messaging.html?highlight=debug#execute
 */
export type ExecuteRequest = JupyterMessage<
	'execute_request',
	{
		code: string;
		silent: boolean;
		store_history: boolean;
		user_expressions: { [key: string]: string };
		allow_stdin: boolean;
		stop_on_error: boolean;
	},
	'shell'
>;

/**
 * @see https://jupyter-client.readthedocs.io/en/stable/messaging.html?highlight=debug#execute
 */
export type ExecuteReply = JupyterMessage<
	'execute_reply',
	{
		status: string;
		execution_count: number;
	},
	'shell'
>;

/**
 * @see https://jupyter-client.readthedocs.io/en/stable/messaging.html?highlight=debug#update-display-data
 */
export type ExecuteResult = JupyterMessage<
	'execute_result',
	{
		data: { [mimeType: string]: string };
		metadata: { [key: string]: unknown };
	},
	'iopub'
>;

/**
 * @see https://jupyter-client.readthedocs.io/en/stable/messaging.html?highlight=debug#display-data
 */
export type DisplayData = JupyterMessage<
	'display_data',
	{
		data: { [mimeType: string]: string };
		metadata: { [key: string]: unknown };
		transient: { [key: string]: unknown };
	},
	'iopub'
>;

/**
 * @see https://jupyter-client.readthedocs.io/en/stable/messaging.html?highlight=debug#display-data
 */
export type StreamOutput = JupyterMessage<
	'stream',
	{
		stream: 'stdout' | 'stderr';
		text: string;
	},
	'iopub'
>;

/**
 * @see https://jupyter-client.readthedocs.io/en/stable/messaging.html?highlight=debug#display-data
 */
export type ExecutionError = JupyterMessage<
	'error',
	{
		ename: string;
		evalue: string;
		traceback: string[];
	},
	'iopub'
>;

//#endregion jupyter-augments

export type TypedJupyerMessage =
	| ExecuteRequest
	| ExecuteReply
	| ExecuteResult
	| DisplayData
	| ExecutionError
	| StreamOutput;

/**
 * Type guard for Jupyter messages. Simply checking msg.header.msg_type
 * is not good enough for TS discriminate between types, for some reason.
 */
export const isMessageType = <T extends MessageType>(
	messageType: T,
	test: TypedJupyerMessage,
): test is TypedJupyerMessage & JupyterMessage<T> => test.header.msg_type === messageType;

//#region factories

const createHeader = <MT extends MessageType>(messageType: MT): JupyterMessageHeader<MT> => ({
	msg_id: randomBytes(8).toString('hex'),
	date: new Date().toISOString(),
	version: '5.2',
	msg_type: messageType,
	username: 'vscode',
	session: randomBytes(8).toString('hex'),
});

export const executeRequest = (
	code: string,
	options: {
		silent?: boolean;
		storeHistory?: boolean;
		userExpressions?: { [key: string]: string };
		allowStdin?: boolean;
		stopOnError?: boolean;
	} = {},
): ExecuteRequest => ({
	channel: 'shell',
	header: createHeader('execute_request'),
	metadata: {},
	parent_header: {},
	content: {
		code,
		silent: options.silent ?? false,
		store_history: options.storeHistory ?? true,
		user_expressions: options.userExpressions ?? {},
		allow_stdin: options.allowStdin ?? true,
		stop_on_error: options.stopOnError ?? false,
	},
	buffers: [new Uint8Array()],
});

export function convertExecutionReplies(messages: TypedJupyerMessage[]) {
	const outputs: vscode.NotebookCellOutput[] = [];
	messages.forEach(message => {
		if (message.header.msg_type === 'execute_result') {
			outputs.push(translateDisplayDataOutput(message.content));
		} else if (message.header.msg_type === 'stream') {
			outputs.push(translateStreamOutput(message.content));
		} else if (message.header.msg_type === 'error') {
			outputs.push(translateErrorOutput(message.content));
		} else if (message.header.msg_type === 'display_data') {
			outputs.push(translateDisplayDataOutput(message.content));
		}
	});

	return outputs;
}


//#endregion

//#region Kernel Provider
export interface IKernelSpec {
	id?: string;
	location?: string;
	locationType?: LocationType;
	binary: string;
	argv: ReadonlyArray<string>;
	displayName: string;
	language: string;
	iconDataUri?: string;
}

export const enum LocationType {
	Global,
	User,
}

export interface IRunningKernel extends IDisposable {
	connection: Connection;
	process: KernelProcess;
}

export class KernelProcess implements IDisposable {
	private _stdout: string[] = [];
	private _stderr: string[] = [];
	private _exit: Error[] = [];

	constructor(private readonly _cp: ChildProcessWithoutNullStreams) {
		_cp.stderr.on('data', (data: string) => this._stderr.push(data));
		_cp.stdout.on('data', (data: string) => this._stdout.push(data));
		_cp.on('error', (err: Error | undefined) => {
			if (err) {
				this._exit.push(err);
			}
		});
		_cp.on('exit', code => {
			if (code !== undefined) {
				this._exit.push(new Error(`Kernel exited with code ${code}`));
			}
		});
	}

	print() {
		console.log('stdout', this._stdout.join(''));
		console.log('stderr', this._stderr.join(''));
		console.log('exit', this._exit);
	}

	dispose() {
		// shutdown cp
		this._cp.kill('SIGKILL');
	}
}

export class KernelProvider {
	async launchKernel(spec: IKernelSpec, env: NodeJS.ProcessEnv, cwd: string | undefined): Promise<IRunningKernel> {
		const connection = await Connection.create();
		const p = new KernelProcess(
			spawn(
				spec.binary,
				spec.argv.map(arg => arg.replace('{connection_file}', connection.connectionFile)),
				{ stdio: 'pipe', env: env, cwd: cwd },
			),
		);

		return {
			connection,
			process: p,
			dispose: () => {
				connection.dispose();
				p.dispose();
			},
		};
	}

	async resolveKernelVariables(kernel: IRunningKernel) {
		const script = generateCodeToFetchVariables();
		const replies = await kernel.connection.sendAndReceive(executeRequest(script));

		const stdout = (replies.find(reply => isMessageType('stream', reply))) as StreamOutput | undefined;
		if (!stdout) {
			return;
		}

		try {
			const variables = JSON.parse(stdout.content.text);
			return variables.map((v: any) => ({
				variable: {
					name: v.name,
					value: v.value,
					type: v.type
				},
				hasNamedChildren: false,
				indexedChildrenCount: 0
			}));
		} catch {
			// ignore
			return [];
		}
	}
}
//#endregion

export async function isValidNotebookCell(accessor: ITestingServicesAccessor, text: string): Promise<boolean> {
	const cacheKey = await createSha256Hash(`notebook-cell-v${NOTEBOOK_CELL_VALID_CACHE_SALT}-${text}`);
	return accessor.get(ICachingResourceFetcher).invokeWithCache(
		CacheScope.Notebook,
		text,
		TestingCacheSalts.notebookCacheSalt,
		cacheKey,
		doIsValidNotebookCell
	);
}

export async function doIsValidNotebookCell(text: string): Promise<boolean> {
	const provider = new KernelProvider();
	const virtualEnvironment = ensurePythonVEnv();

	if (!virtualEnvironment) {
		return false;
	}

	const kernel = await launchKernel(provider, virtualEnvironment, undefined, undefined);

	if (!kernel) {
		return false;
	}

	const replies = await kernel.connection.sendAndReceive(executeRequest(text));
	const executionStatus = replies.reverse().find(reply => isMessageType('execute_reply', reply)) as ExecuteReply | undefined;
	const executionSucceed = executionStatus?.content.status === 'ok';
	kernel.dispose();
	return executionSucceed;
}

export async function launchKernel(provider: KernelProvider, virtualEnvironment: { pythonInterpreter: string; env: NodeJS.ProcessEnv }, cwd: string | undefined, timeout: number | undefined) {
	const doLaunchKernel = async () => {
		const kernel = await provider.launchKernel({
			binary: virtualEnvironment.pythonInterpreter,
			argv: ['-m', 'ipykernel_launcher', '-f', '{connection_file}'],
			displayName: 'Python 3 (ipykernel)',
			language: 'python'
		}, virtualEnvironment.env, cwd);

		return kernel;
	};

	if (timeout) {
		const kernel = await new Promise<IRunningKernel | undefined>((resolve, reject) => {
			const timeout = setTimeout(() => {
				reject('launch kernel timeout');
			}, 5000);

			doLaunchKernel()
				.then((kernel) => {
					clearTimeout(timeout);
					resolve(kernel);
				})
				.catch((error) => {
					clearTimeout(timeout);
					reject(error);
				});
		});

		return kernel;
	} else {
		return doLaunchKernel();
	}
}

export async function executeNotebookCells(notebook: vscode.NotebookDocument, kernel: IRunningKernel, range: NotebookRange, notebookData: ExtHostNotebookDocumentData | undefined) {
	const cells = notebook.getCells(range);
	for (const cell of cells) {
		if (cell.kind === 2) {
			const text = cell.document.getText();
			try {

				const replies = await kernel.connection.sendAndReceive(executeRequest(text));
				notebookData?.appendCellOutput(cell.index, convertExecutionReplies(replies));
				// check if replies contain error
				const errorReply = replies.find(reply => reply.header.msg_type === 'error');
				if (errorReply) {
					return undefined;
				}
			} catch (error) {
				console.error(`Failed to execute cell ${cell.index}: ${error}`);
				return undefined;
			}
		}
	}

	const code = cells.map(cell => cell.document.getText()).join('\n');
	const replies = await kernel.connection.sendAndReceive(executeRequest(code));
	return replies;


}

export function generateCodeToFetchVariables() {
	const script = `def _VSCODE_getVariable(what_to_get, is_debugging, *args):
    # Query Jupyter server for the info about a dataframe
    import json as _VSCODE_json
    import builtins as _VSCODE_builtins
    from collections import namedtuple as _VSCODE_namedtuple
    import importlib.util as _VSCODE_importlib_util

    maxStringLength = 1000
    collectionTypes = ["list", "tuple", "set"]

    def truncateString(variable):
        string = _VSCODE_builtins.repr(variable)
        if _VSCODE_builtins.len(string) > maxStringLength:
            sizeInfo = (
                "\\n\\nLength: " + str(_VSCODE_builtins.len(variable))
                if _VSCODE_builtins.type(variable) == _VSCODE_builtins.str
                else ""
            )
            return string[: maxStringLength - 1] + "..." + sizeInfo
        else:
            return string

    DisplayOptions = _VSCODE_namedtuple("DisplayOptions", ["width", "max_columns"])

    def set_pandas_display_options(display_options=None):
        if _VSCODE_importlib_util.find_spec("pandas") is not None:
            try:
                import pandas as _VSCODE_PD

                original_display = DisplayOptions(
                    width=_VSCODE_PD.options.display.width,
                    max_columns=_VSCODE_PD.options.display.max_columns,
                )

                if display_options:
                    _VSCODE_PD.options.display.max_columns = display_options.max_columns
                    _VSCODE_PD.options.display.width = display_options.width
                else:
                    _VSCODE_PD.options.display.max_columns = 100
                    _VSCODE_PD.options.display.width = 1000

                return original_display
            except ImportError:
                pass
            finally:
                del _VSCODE_PD

    def getValue(variable):
        original_display = None
        if (
            _VSCODE_builtins.type(variable).__name__ == "DataFrame"
            and _VSCODE_importlib_util.find_spec("pandas") is not None
        ):
            original_display = set_pandas_display_options()

        try:
            return truncateString(variable=variable)
        finally:
            if original_display:
                set_pandas_display_options(original_display)

    def getFullType(varType):
        module = ""
        if (
            _VSCODE_builtins.hasattr(varType, "__module__")
            and varType.__module__ != "builtins"
        ):
            module = varType.__module__ + "."
        if _VSCODE_builtins.hasattr(varType, "__qualname__"):
            return module + varType.__qualname__
        elif _VSCODE_builtins.hasattr(varType, "__name__"):
            return module + varType.__name__

    def getVariableDescription(variable):
        result = {}

        varType = _VSCODE_builtins.type(variable)
        result["type"] = getFullType(varType)
        if hasattr(varType, "__mro__"):
            result["interfaces"] = [getFullType(t) for t in varType.__mro__]

        if (
            _VSCODE_builtins.hasattr(variable, "__len__")
            and result["type"] in collectionTypes
        ):
            result["count"] = _VSCODE_builtins.len(variable)

        result["hasNamedChildren"] = (
            _VSCODE_builtins.hasattr(variable, "__dict__")
            or _VSCODE_builtins.type(variable) == dict
        )

        result["value"] = getValue(variable)
        return result

    ### Get info on variables at the root level
    def _VSCODE_getVariableDescriptions(varNames):
        variables = [
            {
                "name": varName,
                **getVariableDescription(globals()[varName]),
                "root": varName,
                "propertyChain": [],
                "language": "python",
            }
            for varName in varNames
            if varName in globals()
        ]

        if is_debugging:
            return _VSCODE_json.dumps(variables)
        else:
            return _VSCODE_builtins.print(_VSCODE_json.dumps(variables))

    def _VSCODE_getVariableTypes(varnames):
        # Map with key: varname and value: vartype
        result = {}
        for name in varnames:
            try:
                vartype = _VSCODE_builtins.type(globals()[name])
                if _VSCODE_builtins.hasattr(vartype, "__name__"):
                    result[name] = vartype.__name__
            except _VSCODE_builtins.TypeError:
                pass
        if is_debugging:
            return _VSCODE_json.dumps(result)
        else:
            return _VSCODE_builtins.print(_VSCODE_json.dumps(result))

    def _VSCODE_getVariableSummary(variable):
        if variable is None:
            return None
        # check if the variable is a dataframe
        if (
            _VSCODE_builtins.type(variable).__name__ == "DataFrame"
            and _VSCODE_importlib_util.find_spec("pandas") is not None
        ):
            return _VSCODE_builtins.print(variable.info())

        return None

    try:
        if what_to_get == "AllVariableDescriptions":
            return _VSCODE_getVariableDescriptions(*args)
        elif what_to_get == "summary":
            return _VSCODE_getVariableSummary(*args)
        else:
            return _VSCODE_getVariableTypes(*args)
    finally:
        del _VSCODE_json
        del _VSCODE_builtins
        del _VSCODE_namedtuple
        del _VSCODE_importlib_util
`;

	const scriptCode = script + '\n\nvariables= %who_ls\n_VSCODE_getVariable("AllVariableDescriptions", False, variables)';

	return scriptCode;
}

export function notebookCellInputFuzzyMatches(cell: vscode.NotebookCell, actual: string) {
	const expected = cell.document.getText();

	if (actual === expected || actual.includes(expected) || expected.includes(actual)) {
		return true;
	}

	if (cell.metadata.tags && Array.isArray(cell.metadata.tags)) {
		const inputMatchingTags = cell.metadata.tags.filter(tag => tag.startsWith('input.includes:')) as string[];

		const includeMatched = inputMatchingTags.find(tag => actual.includes(tag.split('input.includes:')[1].trim()));
		if (includeMatched) {
			return true;
		}

		const inputAnyOfTags = cell.metadata.tags.filter(tag => tag.startsWith('input.anyOf')) as string[];
		const anyOfMatched = inputAnyOfTags.find(tag => {
			// tag: input.anyOf:["a","b"]
			const expectedOutputs = tag.split('input.anyOf:')[1].replace(/[\[\]\"\\]/g, '').split(',');
			return expectedOutputs.some(expectedOutput => actual.includes(expectedOutput.trim()));
		});

		if (anyOfMatched) {
			return true;
		}
	}

	return false;
}

export function notebookCellOutputFuzzyMatches(cell: vscode.NotebookCell, actualOutput: string) {
	if (cell.metadata.tags && Array.isArray(cell.metadata.tags)) {
		const outputIncludesTag = cell.metadata.tags.filter(tag => tag.startsWith('output.includes')) as string[];

		const includeMatched = outputIncludesTag.find(tag => actualOutput.includes(tag.split('output.includes:')[1].trim()));

		if (includeMatched) {
			return true;
		}
	}

	const expectedOutputItem = cell.outputs[0].items.find(item => item.mime === 'text/plain' || item.mime === 'application/vnd.code.notebook.stdout')?.data;
	const decoder = new TextDecoder('utf-8');
	const expectedOutput = (expectedOutputItem ? decoder.decode(expectedOutputItem) : '').trim();
	if (expectedOutput !== '' && actualOutput !== '' && actualOutput === expectedOutput || actualOutput.includes(expectedOutput) || expectedOutput.includes(actualOutput)) {
		return true;
	}
}

/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { createServiceIdentifier } from '../../../util/common/services';
import { Disposable } from '../../../util/vs/base/common/lifecycle';
import { IVSCodeExtensionContext } from '../../extContext/common/extensionContext';
import { ISimulationTestContext } from '../../simulationTestContext/common/simulationTestContext';

export const ILogService = createServiceIdentifier<ILogService>('ILogService');

/**
 * Log levels (taken from vscode.d.ts)
 */
export enum LogLevel {

	/**
	 * No messages are logged with this level.
	 */
	Off = 0,

	/**
	 * All messages are logged with this level.
	 */
	Trace = 1,

	/**
	 * Messages with debug and higher log level are logged with this level.
	 */
	Debug = 2,

	/**
	 * Messages with info and higher log level are logged with this level.
	 */
	Info = 3,

	/**
	 * Messages with warning and higher log level are logged with this level.
	 */
	Warning = 4,

	/**
	 * Only error messages are logged with this level.
	 */
	Error = 5
}

export interface ILogTarget {
	logIt(level: LogLevel, metadataStr: string, ...extra: any[]): void;
	show?(preserveFocus?: boolean): void;
}

// Simple implementation of a log targe used for logging to the console.
export class ConsoleLog implements ILogTarget {
	constructor(private readonly prefix?: string) { }

	logIt(level: LogLevel, metadataStr: string, ...extra: any[]) {
		if (this.prefix) {
			metadataStr = `${this.prefix}${metadataStr}`;
		}

		// Note we don't log INFO or DEBUG messages into console.
		// They are still logged in the output channel.
		if (level === LogLevel.Error) {
			console.error(metadataStr, ...extra);
		} else if (level === LogLevel.Warning) {
			console.warn(metadataStr, ...extra);
		}
	}
}

export interface ILogService extends ILogger {
	readonly _serviceBrand: undefined;
}

/**
 * Mirrors vscode's {@link LogOutputChannel} in terms of available logging functions
 * Args has been ommitted for now in favor of simplifying the interface
 */
export interface ILogger {
	trace(message: string): void;
	debug(message: string): void;
	info(message: string): void;
	warn(message: string): void;
	/**
	 * Logs an error message. Prefer this method over `error()` when logging exception details.
	 *
	 * @param error The Error object that was thrown
	 * @param message An optional message for context (e.g. "Request error"). Must not contain customer data. **Do not include stack trace or messages from the error object.**
	*/
	error(error: string | Error, message?: string): void;
	show(preserveFocus?: boolean): void;
}

export class LogServiceImpl extends Disposable implements ILogService {
	declare _serviceBrand: undefined;

	readonly logger: LoggerImpl;

	constructor(
		logTargets: ILogTarget[],
		@ISimulationTestContext simulationTestContext: ISimulationTestContext,
		@IVSCodeExtensionContext context: IVSCodeExtensionContext,
	) {
		super();
		this.logger = new LoggerImpl(logTargets);
	}

	// Delegate logging methods directly to the internal logger
	trace(message: string): void {
		this.logger.trace(message);
	}

	debug(message: string): void {
		this.logger.debug(message);
	}

	info(message: string): void {
		this.logger.info(message);
	}

	warn(message: string): void {
		this.logger.warn(message);
	}

	error(error: string | Error, message?: string): void {
		this.logger.error(error, message);
	}

	show(preserveFocus?: boolean): void {
		this.logger.show(preserveFocus);
	}
}

class LoggerImpl implements ILogger {
	constructor(
		private readonly _logTargets: ILogTarget[],
	) { }

	private _logIt(level: LogLevel, message: string): void {
		LogMemory.addLog(LogLevel[level], message);
		this._logTargets.forEach(t => t.logIt(level, message));
	}

	trace(message: string): void {
		this._logIt(LogLevel.Trace, message);
	}

	debug(message: string): void {
		this._logIt(LogLevel.Debug, message);
	}

	info(message: string): void {
		this._logIt(LogLevel.Info, message);
	}

	warn(message: string): void {
		this._logIt(LogLevel.Warning, message);
	}

	error(error: string | Error, message?: string): void {
		this._logIt(LogLevel.Error, collectErrorMessages(error) + (message ? `: ${message}` : ''));
	}

	show(preserveFocus?: boolean): void {
		this._logTargets.forEach(t => t.show?.(preserveFocus));
	}
}

export function collectErrorMessages(e: any): string {
	// Collect error messages from nested errors as seen with Node's `fetch`.
	const seen = new Set<any>();
	function collect(e: any, indent: string): string {
		if (!e || !['object', 'string'].includes(typeof e) || seen.has(e)) {
			return '';
		}
		seen.add(e);
		const message = typeof e === 'string' ? e : (e.stack || e.message || e.code || e.toString?.() || '');
		const messageStr = message.toString?.() as (string | undefined) || '';
		return [
			messageStr ? `${messageStr.split('\n').map(line => `${indent}${line}`).join('\n')}\n` : '',
			collect(e.cause, indent + '  '),
			...(Array.isArray(e.errors) ? e.errors.map((e: any) => collect(e, indent + '  ')) : []),
		].join('');
	}
	return collect(e, '')
		.trim();
}

export class LogMemory {
	private static _logs: string[] = [];
	private static _requestIds: string[] = [];
	private static readonly MAX_LOGS = 50;

	/**
	 * Extracts the requestId from a log message if it matches the expected pattern.
	 * Returns a string in the format 'requestId: {string}' or undefined if not found.
	 */
	private static extractRequestIdFromMessage(message: string): string | undefined {
		const match = message.match(/request done: requestId: \[([0-9a-fA-F-]+)\] model deployment ID: \[/);
		if (match) {
			const requestId = match[1];
			if (!this._requestIds.includes(requestId)) {
				return requestId;
			}
		}
		return undefined;
	}

	static addLog(level: string, message: string): void {
		if (this._logs.length >= this.MAX_LOGS) {
			this._logs.shift();
		}
		this._logs.push(`${level}: ${message}`);

		// Extract and store requestId if present
		if (this._requestIds.length >= this.MAX_LOGS) {
			this._requestIds.shift();
		}
		const requestId = this.extractRequestIdFromMessage(message);
		if (requestId) {
			this._requestIds.push(requestId);
		}
	}

	static getLogs(): string[] {
		return this._logs;
	}

	static getRequestIds(): string[] {
		return this._requestIds;
	}
}

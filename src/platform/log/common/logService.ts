/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { createServiceIdentifier } from '../../../util/common/services';
import { Disposable } from '../../../util/vs/base/common/lifecycle';

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

/**
 * Utility functions for creating ILogTarget instances.
 */
export namespace LogTarget {
	/**
	 * Creates an ILogTarget from a simple callback function.
	 *
	 * @example
	 * logger.withExtraTarget(LogTarget.fromCallback((level, msg) => {
	 *     console.log(`[${LogLevel[level]}] ${msg}`);
	 * }));
	 */
	export function fromCallback(fn: (level: LogLevel, message: string) => void): ILogTarget {
		return { logIt: fn };
	}
}

// Simple implementation of a log targe used for logging to the console.
export class ConsoleLog implements ILogTarget {
	constructor(private readonly prefix?: string, private readonly minLogLevel: LogLevel = LogLevel.Warning) { }

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
		} else if (level >= this.minLogLevel) {
			console.log(metadataStr, ...extra);
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

	/**
	 * Creates a sub-logger with a topic prefix. All messages logged through
	 * the sub-logger will be prefixed with the topic, e.g., `[Topic] message`.
	 *
	 * Sub-loggers can be nested, and the prefixes will accumulate,
	 * e.g., `[Parent][Child] message`.
	 *
	 * Sub-loggers inherit extra targets from their parent.
	 *
	 * @param topic The topic name or array of topic names to prefix messages with
	 */
	createSubLogger(topic: string | readonly string[]): ILogger;

	/**
	 * Returns a new logger that also logs to the specified extra target.
	 * The original logger is unchanged (immutable).
	 *
	 * Can be chained to add multiple targets. Sub-loggers created from this
	 * logger will inherit all extra targets.
	 *
	 * Errors thrown by extra targets are silently caught.
	 *
	 * @param target An ILogTarget instance
	 * @returns A new ILogger with the extra target attached
	 *
	 * @example
	 * const logger = logService
	 *     .createSubLogger('MyFeature')
	 *     .withExtraTarget(LogTarget.fromCallback((level, msg) => {
	 *         logContext.trace(msg);
	 *     }));
	 */
	withExtraTarget(target: ILogTarget): ILogger;
}

export class LogServiceImpl extends Disposable implements ILogService {
	declare _serviceBrand: undefined;

	readonly logger: LoggerImpl;

	constructor(
		logTargets: ILogTarget[],
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

	createSubLogger(topic: string | readonly string[]): ILogger {
		return this.logger.createSubLogger(topic);
	}

	withExtraTarget(target: ILogTarget): ILogger {
		return this.logger.withExtraTarget(target);
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

	createSubLogger(topic: string | readonly string[]): ILogger {
		return new SubLogger(this, topic);
	}

	withExtraTarget(target: ILogTarget): ILogger {
		return new LoggerWithExtraTargets(this, [target]);
	}
}

class SubLogger implements ILogger {
	private readonly _prefix: string;

	constructor(
		private readonly _parent: ILogger,
		topic: string | readonly string[],
		existingPrefix?: string,
	) {
		const topics = Array.isArray(topic) ? topic : [topic];
		const newPrefix = topics.map(t => `[${t}]`).join('');
		this._prefix = existingPrefix ? existingPrefix + newPrefix : newPrefix;
	}

	private _prefixMessage(message: string): string {
		return `${this._prefix} ${message}`;
	}

	trace(message: string): void {
		this._parent.trace(this._prefixMessage(message));
	}

	debug(message: string): void {
		this._parent.debug(this._prefixMessage(message));
	}

	info(message: string): void {
		this._parent.info(this._prefixMessage(message));
	}

	warn(message: string): void {
		this._parent.warn(this._prefixMessage(message));
	}

	error(error: string | Error, message?: string): void {
		const prefixedMessage = message ? this._prefixMessage(message) : this._prefix;
		this._parent.error(error, prefixedMessage);
	}

	show(preserveFocus?: boolean): void {
		this._parent.show(preserveFocus);
	}

	createSubLogger(topic: string | readonly string[]): ILogger {
		return new SubLogger(this._parent, topic, this._prefix);
	}

	withExtraTarget(target: ILogTarget): ILogger {
		return new LoggerWithExtraTargets(this, [target], this._prefix);
	}
}

class LoggerWithExtraTargets implements ILogger {
	constructor(
		private readonly _parent: ILogger,
		private readonly _extraTargets: readonly ILogTarget[],
		private readonly _prefix: string = '',
	) { }

	private _notifyExtraTargets(level: LogLevel, message: string): void {
		const prefixedMessage = this._prefix ? `${this._prefix} ${message}` : message;
		for (const target of this._extraTargets) {
			try {
				target.logIt(level, prefixedMessage);
			} catch {
				// Silent catch - extra targets must not affect primary logging
			}
		}
	}

	trace(message: string): void {
		this._notifyExtraTargets(LogLevel.Trace, message);
		this._parent.trace(message);
	}

	debug(message: string): void {
		this._notifyExtraTargets(LogLevel.Debug, message);
		this._parent.debug(message);
	}

	info(message: string): void {
		this._notifyExtraTargets(LogLevel.Info, message);
		this._parent.info(message);
	}

	warn(message: string): void {
		this._notifyExtraTargets(LogLevel.Warning, message);
		this._parent.warn(message);
	}

	error(error: string | Error, message?: string): void {
		// For extra targets, format a simple message
		const errorStr = typeof error === 'string' ? error : (error.message || 'Error');
		const fullMessage = message ? `${errorStr}: ${message}` : errorStr;
		this._notifyExtraTargets(LogLevel.Error, fullMessage);
		this._parent.error(error, message);
	}

	show(preserveFocus?: boolean): void {
		this._parent.show(preserveFocus);
		for (const target of this._extraTargets) {
			try {
				target.show?.(preserveFocus);
			} catch {
				// Silent catch
			}
		}
	}

	createSubLogger(topic: string | readonly string[]): ILogger {
		// Sub-logger inherits extra targets with updated prefix
		const topics = Array.isArray(topic) ? topic : [topic];
		const newPrefix = this._prefix + topics.map(t => `[${t}]`).join('');
		return new LoggerWithExtraTargets(
			this._parent.createSubLogger(topic),
			this._extraTargets,
			newPrefix
		);
	}

	withExtraTarget(target: ILogTarget): ILogger {
		return new LoggerWithExtraTargets(
			this._parent,
			[...this._extraTargets, target],
			this._prefix
		);
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
			e.chromiumDetails ? `${indent}${JSON.stringify(extractChromiumDetails(e.chromiumDetails))}\n` : '',
			collect(e.cause, indent + '  '),
			...(Array.isArray(e.errors) ? e.errors.map((e: any) => collect(e, indent + '  ')) : []),
		].join('');
	}
	return collect(e, '')
		.trim();
}

export function collectSingleLineErrorMessage(e: any, includeDetails = false): string {
	// Collect error messages from nested errors as seen with Node's `fetch`.
	const seen = new Set<any>();
	function collect(e: any): string {
		if (!e || !['object', 'string'].includes(typeof e) || seen.has(e)) {
			return '';
		}
		seen.add(e);
		const message = typeof e === 'string' ? e : (e.message || e.code || e.toString?.() || '');
		const messageStr = message.toString?.() as (string | undefined) || '';
		const messageLine = messageStr.trim().split('\n').join(' ');
		const details = [
			...(includeDetails && e.chromiumDetails ? [JSON.stringify(extractChromiumDetails(e.chromiumDetails))] : []),
			...(e.cause ? [collect(e.cause)] : []),
			...(Array.isArray(e.errors) ? e.errors.map((e: any) => collect(e)) : []),
		].join(', ');
		return details ? `${messageLine}: ${details}` : messageLine;
	}
	return collect(e);
}

function extractChromiumDetails(details: any): any {
	if (!details || typeof details !== 'object') {
		return {};
	}

	const extracted: any = {
		// source_id: details.source_id,
		// host_port_pair: details.host_port_pair,
		// network_anonymization_key: details.network_anonymization_key,
		active_streams: details.active_streams,
		created_streams: details.created_streams,
		pending_create_stream_request_count: details.pending_create_stream_request_count,
		negotiated_protocol: details.negotiated_protocol,
		error: details.error,
		error_on_unavailable: details.error_on_unavailable,
		max_concurrent_streams: details.max_concurrent_streams,
		streams_initiated_count: details.streams_initiated_count,
		streams_abandoned_count: details.streams_abandoned_count,
		stream_hi_water_mark: details.stream_hi_water_mark,
		frames_received: details.frames_received,
		send_window_size: details.send_window_size,
		recv_window_size: details.recv_window_size,
		unacked_recv_window_bytes: details.unacked_recv_window_bytes,
		// support_websocket: details.support_websocket,
		availability_state: details.availability_state,
		last_good_stream_id: details.last_good_stream_id,
		reused: details.reused,
		drain_error: details.drain_error,
		drain_description: details.drain_description,
		go_away_error: details.go_away_error,
		go_away_debug_data: details.go_away_debug_data,
		rst_stream_error: details.rst_stream_error,
		rst_stream_description: details.rst_stream_description,
		aliases_length: Array.isArray(details.aliases) ? details.aliases.length : undefined,
	};

	// Extract proxy schemes
	if (details.proxy) {
		const proxyString = Array.isArray(details.proxy) ? details.proxy.join(' ') : String(details.proxy);
		const proxySchemes = [...proxyString.matchAll(/([a-z][a-z0-9+.-]*):\/\//gi)].map(match => match[1]);
		if (proxySchemes.length > 0) {
			extracted.proxy_schemes = proxySchemes;
		}
	}

	if (details.spdy_session_key && typeof details.spdy_session_key === 'object') {
		extracted.spdy_session = { // Omit _key suffix to avoid filter
			privacy_mode: details.spdy_session_key.privacy_mode,
			secure_dns_policy: details.spdy_session_key.secure_dns_policy,
			disable_cert_verification_network_fetches: details.spdy_session_key.disable_cert_verification_network_fetches,
		};
	}

	if (Array.isArray(details.active_stream_details)) {
		extracted.active_stream_details = details.active_stream_details.map((stream: any) => ({
			stream_id: stream.stream_id,
			io_state: stream.io_state,
			send_stalled_by_flow_control: stream.send_stalled_by_flow_control,
			pending_send_status: stream.pending_send_status,
		}));
	}

	return extracted;
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

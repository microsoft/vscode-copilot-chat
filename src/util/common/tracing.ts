/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


type LogFn = (message: string) => void;

/**
 * @deprecated Use `ILogger.createSubLogger` from `logService.ts` instead.
 */
export interface SubTracingOptions {
	readonly extraLog?: LogFn;
}

/**
 * @deprecated Use `ILogger` from `logService.ts` instead, with `createSubLogger` for topic prefixes.
 */
export interface ITracer {
	trace(message: string, ...payload: unknown[]): void;
	/**
	 * Creates a sub-tracer. Logs when the sub-tracer is created.
	 *
	 * @param name specifies sections, eg ['Git', 'PullRequest']
	 */
	sub(name: string | string[], opts?: SubTracingOptions): ITracer;
	/**
	 * Creates a sub-tracer. Does NOT log when the sub-tracer is created.
	 *
	 * @param name specifies sections, eg ['Git', 'PullRequest']
	 */
	subNoEntry(name: string | string[], opts?: SubTracingOptions): ITracer;
	throws(message?: string, ...payload: unknown[]): void;
	returns(message?: string, ...payload: unknown[]): void;
}

/**
 * @deprecated Use `ILogger.createSubLogger` from `logService.ts` instead.
 */
export class Tracer implements ITracer {
	constructor(
		private readonly section: string | string[],
		private readonly logFn: LogFn,
	) { }

	trace(message: string, ...payload: unknown[]): void {
		this.logFn(this.argsToString(message, payload));
	}

	private argsToString(message: string, payload: unknown[]): string {
		const payloadStr = payload.length ? ` ${this.stringify(payload)}` : '';
		return `[${this.sectionStr}] ${message}${payloadStr}`;
	}

	sub(name: string | string[], opts?: SubTracingOptions): ITracer {
		const sub = this.subNoEntry(name, opts);
		sub.trace('created');
		return sub;
	}

	subNoEntry(name: string | string[], opts?: SubTracingOptions): ITracer {
		const subSection = this.createSubSection(name);
		const extraLog = opts?.extraLog;
		const logFn: LogFn = (
			extraLog === undefined
				? this.logFn
				: (message: string) => {
					this.logFn(message);
					extraLog(message);
				}
		);
		const sub = new Tracer(subSection, logFn);
		return sub;
	}

	throws(message?: string, ...payload: unknown[]): void {
		const payloadStr = payload.length ? ` ${this.stringify(payload)}` : '';
		this.logFn(`[${this.sectionStr}] Throw: ${message ? message : 'void'}${payloadStr}`);
	}

	returns(message?: string, ...payload: unknown[]): void {
		const payloadStr = payload.length ? ` ${this.stringify(payload)}` : '';
		this.logFn(`[${this.sectionStr}] Return: ${message ? message : 'void'}${payloadStr}`);
	}

	private get sectionStr(): string {
		return Array.isArray(this.section) ? this.section.join('][') : this.section;
	}

	private createSubSection(name: string | string[]): string[] {
		return Array.isArray(this.section) ? this.section.concat(name) : [this.section, ...(Array.isArray(name) ? name : [name])];
	}

	private stringify(value: unknown): string {

		function stringifyObj(obj: Object): string {
			const toStringValue = obj.toString();
			if (toStringValue && toStringValue !== '[object Object]') {
				return toStringValue;
			}
			if (obj instanceof Error) {
				return obj.stack || obj.message;
			}
			return JSON.stringify(obj, null, 2);
		}

		if (!value) {
			return JSON.stringify(value, null, 2);
		}
		if (typeof value === 'string') {
			return value;
		}

		if (typeof value === 'function') {
			return value.name ? `[Function: ${value.name}]` : '[Function]';
		}

		if (Array.isArray(value)) {
			return `[${value.map(v => this.stringify(v)).join(', ')}]`;
		}

		if (typeof value === 'object') {
			return stringifyObj(value);
		}

		const valueToString = value.toString();
		if (valueToString && valueToString !== '[object Object]') {
			return valueToString;
		}

		return stringifyObj(value as Object);
	}
}

/**
 * @deprecated Use `ILogger.createSubLogger` from `logService.ts` instead.
 * Example: `logService.createSubLogger(['NES', 'Provider'])`
 */
export function createTracer(section: string | string[], logFn: (message: string) => void): ITracer {
	return new Tracer(section, logFn);
}

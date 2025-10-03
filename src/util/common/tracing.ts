/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

export interface ITracer {
	trace(message: string, ...payload: unknown[]): void;
	/**
	 * Creates a sub-tracer. Logs when the sub-tracer is created.
	 *
	 * @param name specifies sections, eg ['Git', 'PullRequest']
	 */
	sub(name: string | string[]): ITracer;
	/**
	 * Creates a sub-tracer. Does NOT log when the sub-tracer is created.
	 *
	 * @param name specifies sections, eg ['Git', 'PullRequest']
	 */
	subNoEntry(name: string | string[]): ITracer;
	throws(message?: string, ...payload: unknown[]): void;
	returns(message?: string, ...payload: unknown[]): void;
}

export function createTracer(section: string | string[], logFn: (message: string) => void): ITracer {
	const stringify = (value: unknown) => {
		if (!value) {
			return JSON.stringify(value);
		}
		if (typeof value === 'string') {
			return value;
		} else if (typeof value === 'object') {
			const toStringValue = value.toString();
			if (toStringValue && toStringValue !== '[object Object]') {
				return toStringValue;
			}
			if (value instanceof Error) {
				return value.stack || value.message;
			}
			return JSON.stringify(value, null, '\t');
		}
	};
	const sectionStr = Array.isArray(section) ? section.join('][') : section;
	return {
		trace: (message: string, ...payload: unknown[]) => {
			const payloadStr = payload.length ? ` ${stringify(payload)}` : '';
			logFn(`[${sectionStr}] ${message}` + payloadStr);
		},
		sub: (name: string | string[]) => {
			const subSection = Array.isArray(section) ? section.concat(name) : [section, ...(Array.isArray(name) ? name : [name])];
			const sub = createTracer(subSection, logFn);
			sub.trace('created');
			return sub;
		},
		subNoEntry: (name: string | string[]) => {
			const subSection = Array.isArray(section) ? section.concat(name) : [section, ...(Array.isArray(name) ? name : [name])];
			const sub = createTracer(subSection, logFn);
			return sub;
		},
		returns: (message?: string, ...payload: unknown[]) => {
			const payloadStr = payload.length ? ` ${stringify(payload)}` : '';
			logFn(`[${sectionStr}] Return: ${message ? message : 'void'}${payloadStr}`);
		},
		throws: (message?: string, ...payload: unknown[]) => {
			const payloadStr = payload.length ? ` ${stringify(payload)}` : '';
			logFn(`[${sectionStr}] Throw: ${message ? message : 'void'}${payloadStr}`);
		}
	};
}

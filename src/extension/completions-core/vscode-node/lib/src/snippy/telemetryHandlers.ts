/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
import { Context } from '../context';
import { codeReferenceLogger } from './logger';
import { telemetry, TelemetryData, telemetryError } from '../telemetry';

export type TelemetryActor = 'user' | 'system';

type Base = {
	context: Context;
};
type MatchUIDetails = Base & { actor: TelemetryActor };

type PostInsertionErrorDetails = Base & {
	origin: string;
	reason: string;
};

type SnippyNetworkErrorDetails = PostInsertionErrorDetails & {
	message: string;
};

// Check for valid http status code format. We use 6xx internally.
const statusCodeRe = /^[1-6][0-9][0-9]$/;
// Look for capital letters followed by lowercase letters.
const capitalsRe = /([A-Z][a-z]+)/;
const NAMESPACE = 'code_referencing';

class CodeQuoteTelemetry {
	constructor(protected readonly baseKey: string) { }
	buildKey(...keys: string[]) {
		return [NAMESPACE, this.baseKey, ...keys].join('.');
	}
}

class CopilotOutputLogTelemetry extends CodeQuoteTelemetry {
	constructor() {
		super('github_copilot_log');
	}

	handleOpen({ context }: Base) {
		const key = this.buildKey('open', 'count');
		const data = TelemetryData.createAndMarkAsIssued();
		telemetry(context, key, data);
	}

	handleFocus({ context }: Base) {
		const data = TelemetryData.createAndMarkAsIssued();
		const key = this.buildKey('focus', 'count');
		telemetry(context, key, data);
	}

	handleWrite({ context }: Base) {
		const data = TelemetryData.createAndMarkAsIssued();
		const key = this.buildKey('write', 'count');
		telemetry(context, key, data);
	}
}

export const copilotOutputLogTelemetry = new CopilotOutputLogTelemetry();

class MatchNotificationTelemetry extends CodeQuoteTelemetry {
	constructor() {
		super('match_notification');
	}

	handleDoAction({ context, actor }: MatchUIDetails) {
		const data = TelemetryData.createAndMarkAsIssued({ actor });
		const key = this.buildKey('acknowledge', 'count');
		telemetry(context, key, data);
	}

	handleDismiss({ context, actor }: MatchUIDetails) {
		const data = TelemetryData.createAndMarkAsIssued({ actor });
		const key = this.buildKey('ignore', 'count');
		telemetry(context, key, data);
	}
}

export const matchNotificationTelemetry = new MatchNotificationTelemetry();

class SnippyTelemetry extends CodeQuoteTelemetry {
	constructor() {
		super('snippy');
	}

	handleUnexpectedError({ context, origin, reason }: PostInsertionErrorDetails) {
		const data = TelemetryData.createAndMarkAsIssued({ origin, reason });
		telemetryError(context, this.buildKey('unexpectedError'), data);
	}

	handleCompletionMissing({ context, origin, reason }: PostInsertionErrorDetails) {
		const data = TelemetryData.createAndMarkAsIssued({ origin, reason });
		telemetryError(context, this.buildKey('completionMissing'), data);
	}

	handleSnippyNetworkError({ context, origin, reason, message }: SnippyNetworkErrorDetails) {
		if (!origin.match(statusCodeRe)) {
			codeReferenceLogger.debug(context, 'Invalid status code, not sending telemetry', { origin });
			return;
		}

		// reason is a string like "SnippyNetworkError". We want to format it to use underscores, which
		// is the standard for Copilot telemetry keys.
		const errorType = reason
			.split(capitalsRe)
			.filter(part => Boolean(part))
			.join('_')
			.toLowerCase();
		const data = TelemetryData.createAndMarkAsIssued({ message });
		telemetryError(context, this.buildKey(errorType, origin), data);
	}
}

export const snippyTelemetry = new SnippyTelemetry();

/** @public KEEPING FOR TESTS */
export class NoopTelemetryReporter extends CodeQuoteTelemetry {
	constructor(baseKey = '') {
		super(baseKey);
	}
	telemetry(...args: Parameters<typeof telemetry>) { }
	telemetryError(...args: Parameters<typeof telemetryError>) { }
}

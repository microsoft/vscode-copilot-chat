/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
import type tt from 'typescript/lib/tsserverlibrary';
import { computeContext, prepareNesRename } from '../common/api';
import { CharacterBudget, ContextResult, LanguageServerSession, RequestContext, TokenBudgetExhaustedError } from '../common/contextProvider';
import { ErrorCode, RenameKind, type CachedContextRunnableResult, type ComputeContextRequest, type ComputeContextResponse, type ContextRunnableResultId, type PingResponse, type PrepareNesRenameRequest, type PrepareNesRenameResponse } from '../common/protocol';
import { CancellationTokenWithTimer } from '../common/typescripts';

import { PrepareNesRenameResult } from '../common/nesRenameValidator';
import TS from '../common/typescript';
import { NodeHost } from './host';
const ts = TS();

interface ComputeContextHandlerResponse extends tt.server.HandlerResponse {
	response: ComputeContextResponse.OK | ComputeContextResponse.Failed;
}

interface PrepareNesRenameHandlerResponse extends tt.server.HandlerResponse {
	response: PrepareNesRenameResponse.OK | PrepareNesRenameResponse.Failed;
}

let installAttempted: boolean = false;
let languageServerSession: LanguageServerSession | undefined = undefined;
let languageServiceHost: tt.LanguageServiceHost | undefined = undefined;
let pingResult: PingResponse.OK | PingResponse.Error = { kind: 'error', message: 'Attempt to install context handler failed' };

const computeContextHandler = (request: ComputeContextRequest): ComputeContextHandlerResponse => {
	const totalStart = Date.now();
	if (request.arguments === undefined) {
		return { response: { error: ErrorCode.noArguments, message: 'No arguments provided' }, responseRequired: true };
	}
	const args = request.arguments;
	const fileAndProject = languageServerSession?.getFileAndProject(args);
	if (fileAndProject === undefined) {
		return { response: { error: ErrorCode.noProject, message: 'No project found' }, responseRequired: true };
	}
	if (typeof args.line !== 'number' || typeof args.offset !== 'number') {
		return { response: { error: ErrorCode.invalidArguments, message: 'No project found' }, responseRequired: true };
	}
	const { file, project } = fileAndProject;
	const pos = languageServerSession?.getPositionInFile(args, file);
	if (pos === undefined) {
		return { response: { error: ErrorCode.invalidPosition, message: 'Position not valid' }, responseRequired: true };
	}

	let startTime = request.arguments?.startTime ?? totalStart;
	let timeBudget = typeof args.timeBudget === 'number' ? args.timeBudget : 100;
	if (startTime + timeBudget > totalStart) {
		// We are already in a timeout. So we let the computation run for 100ms
		// to profit from caching for the next request. In all other cases we take
		// the time budget left since we might be able to provide a little context.
		startTime = totalStart;
		timeBudget = 100;
	}

	// We get the language service here to get the timings outside of the compute context. Accessing the language service
	// updates the project graph if dirty which can be time consuming.
	const languageService = project.getLanguageService();
	const program = languageService.getProgram();
	if (program === undefined) {
		return { response: { error: ErrorCode.noProgram, message: 'No program found' }, responseRequired: true };
	}

	const computeStart = Date.now();
	const primaryCharacterBudget = new CharacterBudget(typeof args.primaryCharacterBudget === 'number' ? args.primaryCharacterBudget : 7 * 1024 * 4);
	const secondaryCharacterBudget = new CharacterBudget(typeof args.secondaryCharacterBudget === 'number' ? args.secondaryCharacterBudget : 8 * 1024 * 4);
	const normalizedPaths: tt.server.NormalizedPath[] = [];
	if (args.neighborFiles !== undefined) {
		for (const file of args.neighborFiles) {
			normalizedPaths.push(ts.server.toNormalizedPath(file));
		}
	}
	const clientSideRunnableResults: Map<ContextRunnableResultId, CachedContextRunnableResult> = args.clientSideRunnableResults !== undefined ? new Map(args.clientSideRunnableResults.map(item => [item.id, item])) : new Map();
	const cancellationToken = new CancellationTokenWithTimer(languageServiceHost?.getCancellationToken ? languageServiceHost.getCancellationToken() : undefined, startTime, timeBudget, languageServerSession?.host.isDebugging() ?? false);
	const requestContext = new RequestContext(languageServerSession!, normalizedPaths, clientSideRunnableResults, !!args.includeDocumentation);
	const result: ContextResult = new ContextResult(primaryCharacterBudget, secondaryCharacterBudget, requestContext);
	try {
		computeContext(result, languageServerSession!, languageService, file, pos, cancellationToken);
	} catch (error) {
		if (!(error instanceof ts.OperationCanceledException) && !(error instanceof TokenBudgetExhaustedError)) {
			if (error instanceof Error) {
				return { response: { error: ErrorCode.exception, message: error.message, stack: error.stack }, responseRequired: true };
			} else {
				return { response: { error: ErrorCode.exception, message: 'Unknown error' }, responseRequired: true };
			}
		}
	}
	const endTime = Date.now();
	result.addTimings(endTime - totalStart, endTime - computeStart);
	result.setTimedOut(cancellationToken.isTimedOut());
	return { response: result.toJson(), responseRequired: true };
};

const prepareNesRenameHandler = (request: PrepareNesRenameRequest): PrepareNesRenameHandlerResponse => {
	const totalStart = Date.now();
	if (request.arguments === undefined) {
		return { response: { error: ErrorCode.noArguments, message: 'No arguments provided' }, responseRequired: true };
	}

	const args = request.arguments;
	let startTime = request.arguments?.startTime ?? totalStart;
	let timeBudget = typeof args.timeBudget === 'number' ? args.timeBudget : 100;
	if (startTime + timeBudget > totalStart) {
		startTime = totalStart;
		timeBudget = 50;
	}

	const fileAndProject = languageServerSession?.getFileAndProject(args);
	if (fileAndProject === undefined) {
		return { response: { error: ErrorCode.noProject, message: 'No project found' }, responseRequired: true };
	}
	if (typeof args.line !== 'number' || typeof args.offset !== 'number') {
		return { response: { error: ErrorCode.invalidArguments, message: 'No project found' }, responseRequired: true };
	}
	const { file, project } = fileAndProject;
	const pos = languageServerSession?.getPositionInFile(args, file);
	if (pos === undefined) {
		return { response: { error: ErrorCode.invalidPosition, message: 'Position not valid' }, responseRequired: true };
	}
	const cancellationToken = new CancellationTokenWithTimer(languageServiceHost?.getCancellationToken ? languageServiceHost.getCancellationToken() : undefined, startTime, timeBudget, languageServerSession?.host.isDebugging() ?? false);
	const result: PrepareNesRenameResult = new PrepareNesRenameResult();
	try {
		prepareNesRename(result, project.getLanguageService(), file, pos, request.arguments?.oldName, request.arguments?.newName, cancellationToken);
	} catch (error) {
		if (error instanceof ts.OperationCanceledException) {
			result.setCanRename(RenameKind.no, 'Operation canceled');
		} else {
			if (error instanceof Error) {
				return { response: { error: ErrorCode.exception, message: error.message, stack: error.stack }, responseRequired: true };
			} else {
				return { response: { error: ErrorCode.exception, message: 'Unknown error' }, responseRequired: true };
			}
		}
	}
	result.setTimedOut(cancellationToken.isTimedOut());
	return { response: result.toJsonResponse(), responseRequired: true };
};

export function create(info: tt.server.PluginCreateInfo): tt.LanguageService {
	if (installAttempted) {
		return info.languageService;
	}
	if (info.session !== undefined) {
		try {

			info.session.addProtocolHandler('_.copilot.ping', () => {
				return { response: pingResult, responseRequired: true };
			});
			try {
				const versionSupported = isSupportedVersion();
				pingResult = { kind: 'ok', session: true, supported: versionSupported, version: ts.version };
				if (versionSupported) {
					languageServerSession = new LanguageServerSession(info.session, new NodeHost());
					languageServiceHost = info.languageServiceHost;
					info.session.addProtocolHandler('_.copilot.context', computeContextHandler);
					info.session.addProtocolHandler('_.copilot.prepareNesRename', prepareNesRenameHandler);
				}

			} catch (e) {
				if (e instanceof Error) {
					pingResult = { kind: 'error', message: e.message, stack: e.stack };
					info.session.logError(e, '_.copilot.installHandler');
				} else {
					pingResult = { kind: 'error', message: 'Unknown error' };
					info.session.logError(new Error('Unknown error'), '_.copilot.installHandler');
				}
			}
		} catch (error) {
			if (error instanceof Error) {
				info.session.logError(error, '_.copilot.installPingHandler');
			} else {
				info.session.logError(new Error('Unknown error'), '_.copilot.installPingHandler');
			}
		} finally {
			installAttempted = true;
		}
	}

	return info.languageService;
}

function isSupportedVersion(): boolean {
	try {
		const version = ts.versionMajorMinor.split('.');
		if (version.length < 2) {
			return false;
		}
		const major = parseInt(version[0]);
		const minor = parseInt(version[1]);
		return major > 5 || (major === 5 && minor >= 5);
	} catch (e) {
		return false;
	}
}
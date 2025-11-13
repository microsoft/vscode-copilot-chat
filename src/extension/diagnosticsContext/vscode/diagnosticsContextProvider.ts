/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { ConfigKey, IConfigurationService } from '../../../platform/configuration/common/configurationService';
import { Copilot } from '../../../platform/inlineCompletions/common/api';
import { ILanguageContextProviderService } from '../../../platform/languageContextProvider/common/languageContextProviderService';
import { ILanguageDiagnosticsService } from '../../../platform/languages/common/languageDiagnosticsService';
import { ILogService } from '../../../platform/log/common/logService';
import { IExperimentationService } from '../../../platform/telemetry/common/nullExperimentationService';
import { CancellationToken } from '../../../util/vs/base/common/cancellation';
import { Disposable, DisposableStore, IDisposable } from '../../../util/vs/base/common/lifecycle';
import { autorun, IObservable } from '../../../util/vs/base/common/observableInternal';
import { URI } from '../../../util/vs/base/common/uri';
import { Position } from '../../../util/vs/editor/common/core/position';
import { Range } from '../../../util/vs/editor/common/core/range';
import { Range as ExternalRange } from '../../../vscodeTypes';

export class DiagnosticsContextContribution extends Disposable {

	private readonly _enableDiagnosticsContextProvider: IObservable<boolean>;

	constructor(
		@IConfigurationService configurationService: IConfigurationService,
		@ILogService private readonly logService: ILogService,
		@IExperimentationService experimentationService: IExperimentationService,
		@ILanguageDiagnosticsService private readonly diagnostocsService: ILanguageDiagnosticsService,
		@ILanguageContextProviderService private readonly languageContextProviderService: ILanguageContextProviderService,
	) {
		super();
		this._enableDiagnosticsContextProvider = configurationService.getExperimentBasedConfigObservable(ConfigKey.Internal.DiagnosticsContextProvider, experimentationService);
		this._register(autorun(reader => {
			if (this._enableDiagnosticsContextProvider.read(reader)) {
				reader.store.add(this.register());
			}
		}));
	}

	private register(): IDisposable {
		const disposables = new DisposableStore();
		try {
			const resolver = new ContextResolver(this.diagnostocsService);
			const provider: Copilot.ContextProvider<Copilot.SupportedContextItem> = {
				id: 'diagnostics-context-provider',
				selector: "*",
				resolver: resolver
			};
			disposables.add(this.languageContextProviderService.registerContextProvider(provider));
		} catch (error) {
			this.logService.error('Error regsistering prompt file context provider:', error);
		}
		return disposables;
	}
}

type DiagnosticsContextOptions = {
	maxDiagnostics: number;
	includeDiagnosticsRange?: Range;
};

class ContextResolver implements Copilot.ContextResolver<Copilot.SupportedContextItem> {

	constructor(
		private readonly diagnostocsService: ILanguageDiagnosticsService,
	) { }

	async resolve(request: Copilot.ResolveRequest, token: CancellationToken): Promise<Copilot.SupportedContextItem[]> {
		return []; // resolve only on timeout to ensure the state of diagnostics is as fresh as possible
	}

	resolveOnTimeout(request: Copilot.ResolveRequest): Copilot.SupportedContextItem[] {
		if (!request.documentContext.position) {
			return [];
		}

		const requestedFileResource = URI.parse(request.documentContext.uri);
		const cursor = new Position(
			request.documentContext.position.line + 1,
			request.documentContext.position.character + 1,
		);

		return this.getContext(requestedFileResource, cursor, {
			maxDiagnostics: 3,
			includeDiagnosticsRange: new Range(cursor.lineNumber, 1, cursor.lineNumber + 5, 1)
		});
	}

	private getContext(resource: URI, cursor: Position, options: DiagnosticsContextOptions): Copilot.SupportedContextItem[] {
		let diagnostics = this.diagnostocsService.getDiagnostics(resource);

		if (options.includeDiagnosticsRange) {
			diagnostics = diagnostics.filter(d => options.includeDiagnosticsRange!.containsRange(toInternalRange(d.range)));
		}

		const diagnosticsSortedByDistance = diagnostics.sort((a, b) => {
			const aDistance = Math.abs(a.range.start.line + 1 - cursor.lineNumber);
			const bDistance = Math.abs(b.range.start.line + 1 - cursor.lineNumber);
			return aDistance - bDistance;
		});

		const diagnosticsLimited = diagnosticsSortedByDistance.slice(0, options.maxDiagnostics);

		const errorDiagnostics = diagnosticsLimited.filter(d => d.severity === 0);
		const warningsDiagnostics = diagnosticsLimited.filter(d => d.severity === 1);

		const traits: Copilot.Trait[] = [];
		if (errorDiagnostics.length > 0) {
			traits.push({
				name: "There are the following errors near the users cursor",
				value: errorDiagnostics.map(d => `- ${d.message}`).join('\n'),
			});
		}

		if (warningsDiagnostics.length > 0) {
			traits.push({
				name: "There are the following warnings near the users cursor",
				value: warningsDiagnostics.map(d => `- ${d.message}`).join('\n'),
			});
		}

		return traits;
	}
}

function toInternalRange(range: ExternalRange): Range {
	return new Range(range.start.line + 1, range.start.character + 1, range.end.line + 1, range.end.character + 1);
}
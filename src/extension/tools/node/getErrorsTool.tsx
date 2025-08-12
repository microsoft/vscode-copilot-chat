/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as l10n from '@vscode/l10n';
import { BasePromptElementProps, PromptElement, PromptElementProps } from '@vscode/prompt-tsx';
import type * as vscode from 'vscode';
import { ILanguageDiagnosticsService } from '../../../platform/languages/common/languageDiagnosticsService';
import { ILogService } from '../../../platform/log/common/logService';
import { IPromptPathRepresentationService } from '../../../platform/prompts/common/promptPathRepresentationService';
import { IWorkspaceService } from '../../../platform/workspace/common/workspaceService';
import { getLanguage } from '../../../util/common/languages';
import { isLocation } from '../../../util/common/types';
import { CancellationToken } from '../../../util/vs/base/common/cancellation';
import { Disposable } from '../../../util/vs/base/common/lifecycle';
import { URI } from '../../../util/vs/base/common/uri';
import { IInstantiationService } from '../../../util/vs/platform/instantiation/common/instantiation';
import { DiagnosticSeverity, ExtendedLanguageModelToolResult, LanguageModelPromptTsxPart, MarkdownString, Range } from '../../../vscodeTypes';
import { findDiagnosticForSelectionAndPrompt } from '../../context/node/resolvers/fixSelection';
import { IBuildPromptContext } from '../../prompt/common/intents';
import { renderPromptElementJSON } from '../../prompts/node/base/promptRenderer';
import { Tag } from '../../prompts/node/base/tag';
import { DiagnosticContext, Diagnostics } from '../../prompts/node/inline/diagnosticsContext';
import { ToolName } from '../common/toolNames';
import { ICopilotTool, ToolRegistry } from '../common/toolsRegistry';
import { checkCancellation, formatUriForFileWidget, resolveToolInputPath } from './toolUtils';
import { coalesce } from '../../../util/vs/base/common/arrays';

interface IGetErrorsParams {
	// Note that empty array is not the same as absence; empty array
	// will not return any errors. Absence returns all errors.
	filePaths?: string[];
	// sparse array of ranges, as numbers because it goes through JSON
	// ignored if filePaths is missing / null.
	ranges?: ([a: number, b: number, c: number, d: number] | undefined)[];
}

class GetErrorsTool extends Disposable implements ICopilotTool<IGetErrorsParams> {
	public static readonly toolName = ToolName.GetErrors;

	constructor(
		@IInstantiationService private readonly instantiationService: IInstantiationService,
		@ILanguageDiagnosticsService private readonly languageDiagnosticsService: ILanguageDiagnosticsService,
		@IWorkspaceService private readonly workspaceService: IWorkspaceService,
		@IPromptPathRepresentationService private readonly promptPathRepresentationService: IPromptPathRepresentationService,
		@ILogService private readonly logService: ILogService
	) {
		super();
	}

	async invoke(options: vscode.LanguageModelToolInvocationOptions<IGetErrorsParams>, token: CancellationToken) {
		const getAll = () => this.languageDiagnosticsService.getAllDiagnostics()
			.map(d => ({ uri: d[0], diagnostics: d[1].filter(e => e.severity <= DiagnosticSeverity.Warning) }))
			// filter any documents w/o warnings or errors
			.filter(d => d.diagnostics.length > 0);

		const getSome = (filePaths: string[]) => filePaths.map((filePath, i) => {
			const uri = resolveToolInputPath(filePath, this.promptPathRepresentationService);
			const range = options.input.ranges?.[i];
			if (!uri) {
				throw new Error(`Invalid input path ${filePath}`);
			}

			let diagnostics = range
				? findDiagnosticForSelectionAndPrompt(this.languageDiagnosticsService, uri, new Range(...range), undefined)
				: this.languageDiagnosticsService.getDiagnostics(uri);

			diagnostics = diagnostics.filter(d => d.severity <= DiagnosticSeverity.Warning);

			return {
				diagnostics,
				uri,
			};
		});

		const ds = options.input.filePaths?.length ? getSome(options.input.filePaths) : getAll();

		const diagnostics = coalesce(await Promise.all(ds.map((async ({ uri, diagnostics }) => {
			try {
				const document = await this.workspaceService.openTextDocumentAndSnapshot(uri);
				checkCancellation(token);
				return {
					uri,
					diagnostics,
					context: { document, language: getLanguage(document) }
				};
			} catch (e) {
				this.logService.error(e, 'get_errors failed to open doc with diagnostics');
				return undefined;
			}
		}))));
		checkCancellation(token);

		const result = new ExtendedLanguageModelToolResult([
			new LanguageModelPromptTsxPart(
				await renderPromptElementJSON(this.instantiationService, DiagnosticToolOutput, { diagnosticsGroups: diagnostics, maxDiagnostics: 50 }, options.tokenizationOptions, token)
			)
		]);

		const numDiagnostics = diagnostics.reduce((acc, { diagnostics }) => acc + diagnostics.length, 0);
		const formattedURIs = this.formatURIs(diagnostics.map(d => d.uri));
		if (options.input.filePaths?.length) {
			result.toolResultMessage = numDiagnostics === 0 ?
				new MarkdownString(l10n.t`Checked ${formattedURIs}, no problems found`) :
				numDiagnostics === 1 ?
					new MarkdownString(l10n.t`Checked ${formattedURIs}, 1 problem found`) :
					new MarkdownString(l10n.t`Checked ${formattedURIs}, ${numDiagnostics} problems found`);
		} else {
			result.toolResultMessage = numDiagnostics === 0 ?
				new MarkdownString(l10n.t`Checked workspace, no problems found`) :
				numDiagnostics === 1 ?
					new MarkdownString(l10n.t`Checked workspace, 1 problem found in ${formattedURIs}`) :
					new MarkdownString(l10n.t`Checked workspace, ${numDiagnostics} problems found in ${formattedURIs}`);
		}

		return result;
	}

	prepareInvocation(options: vscode.LanguageModelToolInvocationPrepareOptions<IGetErrorsParams>, token: vscode.CancellationToken): vscode.ProviderResult<vscode.PreparedToolInvocation> {
		if (!options.input.filePaths?.length) {
			// When no file paths provided, check all files with diagnostics
			return {
				invocationMessage: new MarkdownString(l10n.t`Checking workspace for problems`),
			};
		}
		else {
			const uris = options.input.filePaths.map(filePath => resolveToolInputPath(filePath, this.promptPathRepresentationService));
			if (uris.some(uri => uri === undefined)) {
				throw new Error('Invalid file path provided');
			}

			return {
				invocationMessage: new MarkdownString(l10n.t`Checking ${this.formatURIs(uris)}`),
			};
		}
	}

	private formatURIs(uris: URI[]): string {
		return uris.map(formatUriForFileWidget).join(', ');
	}

	async provideInput(promptContext: IBuildPromptContext): Promise<IGetErrorsParams | undefined> {
		const seen = new Set<string>();

		const filePaths: string[] = [];
		const ranges: ([a: number, b: number, c: number, d: number] | undefined)[] = [];

		function addPath(path: string, range: vscode.Range | undefined) {
			if (!seen.has(path)) {
				seen.add(path);
				filePaths.push(path);
				ranges.push(range && [range.start.line, range.start.character, range.end.line, range.end.character]);
			}
		}

		for (const ref of promptContext.chatVariables) {
			if (URI.isUri(ref.value)) {
				addPath(this.promptPathRepresentationService.getFilePath(ref.value), undefined);
			} else if (isLocation(ref.value)) {
				addPath(this.promptPathRepresentationService.getFilePath(ref.value.uri), ref.value.range);
			}
		}

		if (promptContext.workingSet) {
			for (const file of promptContext.workingSet) {
				addPath(this.promptPathRepresentationService.getFilePath(file.document.uri), file.range);
			}
		}

		if (!filePaths.length) {
			for (const [uri, diags] of this.languageDiagnosticsService.getAllDiagnostics()) {
				const path = this.promptPathRepresentationService.getFilePath(uri);
				if (diags.length) {
					let range = diags[0].range;
					for (let i = 1; i < diags.length; i++) {
						range = range.union(diags[i].range);
					}
					addPath(path, range);
				}
			}
		}

		return {
			filePaths,
			ranges
		};
	}
}

ToolRegistry.registerTool(GetErrorsTool);

interface IDiagnosticToolOutputProps extends BasePromptElementProps {
	diagnosticsGroups: { context: DiagnosticContext; uri: URI; diagnostics: vscode.Diagnostic[] }[];
	maxDiagnostics?: number;
}

export class DiagnosticToolOutput extends PromptElement<IDiagnosticToolOutputProps> {
	constructor(
		props: PromptElementProps<IDiagnosticToolOutputProps>,
		@IPromptPathRepresentationService private readonly promptPathRepresentationService: IPromptPathRepresentationService,
	) {
		super(props);
	}

	render() {
		if (!this.props.diagnosticsGroups.length) {
			return <>No errors found.</>;
		}

		let diagnosticsGroups = this.props.diagnosticsGroups;
		let limitMsg;
		if (typeof this.props.maxDiagnostics === 'number') {
			let remaining = this.props.maxDiagnostics;
			diagnosticsGroups = this.props.diagnosticsGroups.map(group => {
				if (remaining <= 0) {
					return { ...group, diagnostics: [] };
				}
				const take = Math.min(group.diagnostics.length, remaining);
				remaining -= take;
				return { ...group, diagnostics: group.diagnostics.slice(0, take) };
			});
			const totalDiagnostics = this.props.diagnosticsGroups.reduce((acc, group) => acc + group.diagnostics.length, 0);
			limitMsg = totalDiagnostics > this.props.maxDiagnostics
				? <>Showing first {this.props.maxDiagnostics} results out of {totalDiagnostics}<br /></>
				: undefined;
		}

		return <>
			{limitMsg}
			{diagnosticsGroups.map(d =>
				<Tag name='errors' attrs={{ path: this.promptPathRepresentationService.getFilePath(d.uri) }}>
					{d.diagnostics.length
						? <Diagnostics
							documentContext={d.context}
							diagnostics={d.diagnostics}
							includeRelatedInfos={false} // avoid blowing up the prompt #12655
						/>
						: 'No errors found'}
				</Tag>
			)}
		</>;
	}
}

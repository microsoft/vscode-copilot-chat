/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { PromptElement, PromptElementProps, PromptSizing } from '@vscode/prompt-tsx';
import { ChatLocation } from '../../../../platform/chat/common/commonTypes';
import { ConfigKey, IConfigurationService } from '../../../../platform/configuration/common/configurationService';
import { NotebookDocumentSnapshot } from '../../../../platform/editing/common/notebookDocumentSnapshot';
import { TextDocumentSnapshot } from '../../../../platform/editing/common/textDocumentSnapshot';
import { IHeatmapService, SelectionPoint } from '../../../../platform/heatmap/common/heatmapService';
import { IParserService } from '../../../../platform/parser/node/parserService';
import { IExperimentationService } from '../../../../platform/telemetry/common/nullExperimentationService';
import { Iterable } from '../../../../util/vs/base/common/iterator';
import { ResourceMap } from '../../../../util/vs/base/common/map';
import { clamp } from '../../../../util/vs/base/common/numbers';
import { isEqual } from '../../../../util/vs/base/common/resources';
import { isFalsyOrWhitespace } from '../../../../util/vs/base/common/strings';
import { IInstantiationService, ServicesAccessor } from '../../../../util/vs/platform/instantiation/common/instantiation';
import { Uri } from '../../../../vscodeTypes';
import { TelemetryData } from '../../../prompt/node/intents';
import { Tag } from '../base/tag';
import { CodeBlock, Uri as UriElement, UriMode } from '../panel/safeElements';
import { ProjectedDocument } from './summarizedDocument/summarizeDocument';
import { SummarizeDocumentsItem, summarizeDocuments } from './summarizedDocument/summarizeDocumentHelpers';

export interface DocumentProjectionPair {
	doc: TextDocumentSnapshot | NotebookDocumentSnapshot;
	projectedDoc: ProjectedDocument;
}

export async function summarizeTemporalContext(accessor: ServicesAccessor, tokenBudget: number, currentDocs: (IDocument | TextDocumentSnapshot | NotebookDocumentSnapshot)[]): Promise<ReadonlyMap<string, DocumentProjectionPair>> {

	const heatmapService = accessor.get(IHeatmapService);
	const parserService = accessor.get(IParserService);
	const configService = accessor.get(IConfigurationService);
	const expService = accessor.get(IExperimentationService);

	const entries = await heatmapService.getEntries();
	const entriesByUri = new ResourceMap<SelectionPoint[]>();

	const now = Date.now();
	const maxAgeMillis = 1000 * clamp(
		configService.getExperimentBasedConfig(ConfigKey.AdvancedExperimentalExperiments.TemporalContextMaxAge, expService),
		0,
		Number.MAX_SAFE_INTEGER
	);

	const input: SummarizeDocumentsItem[] = [];

	let minTimestamp = Number.MAX_SAFE_INTEGER;
	let maxTimestamp = 0;

	// build input, check filter
	for (let [key, value] of entries) {

		// Ignore the current doc
		if (currentDocs.some(doc => isEqual(key.uri, doc.uri))) {
			continue;
		}

		// Ignore values that are too old
		value = value.filter(point => (now - point.timestamp) <= maxAgeMillis);
		if (value.length === 0) {
			continue;
		}

		input.push({
			document: TextDocumentSnapshot.create(key),
			formattingOptions: undefined,
			selection: undefined
		});
		entriesByUri.set(key.uri, value);

		// find old/young timestamps
		for (const point of value) {
			if (point.timestamp < minTimestamp) {
				minTimestamp = point.timestamp;
			}
			if (point.timestamp > maxTimestamp) {
				maxTimestamp = point.timestamp;
			}
		}
	}
	const timespawn = (maxTimestamp - minTimestamp);

	if (input.length === 0) {
		return new Map();
	}

	const preferSameLang = configService.getExperimentBasedConfig(ConfigKey.AdvancedExperimentalExperiments.TemporalContextPreferSameLang, expService);

	// summarize
	const documents = await summarizeDocuments(parserService, input, tokenBudget, {

		costFnOverride: (node, currentCost, snapshot) => {
			const points = entriesByUri.get(snapshot.uri);

			if (!points) {
				return false; // should not happen
			}

			// add some cost if the language is different
			const langCost = preferSameLang && currentDocs.some(doc => snapshot.languageId !== doc.languageId) ? 1 : 0;

			let distance = Number.MAX_SAFE_INTEGER;

			for (const point of points) {
				if (node.range.contains(point.offset)) {
					const age = timespawn && 1 - ((point.timestamp - minTimestamp) / timespawn);
					if (node.children.length === 0) {
						return 1 + langCost + age; // truly selected
					} else {
						return 3 + langCost + age + currentCost;
					}
				}

				distance = Math.min(
					distance,
					Math.abs(point.offset - node.range.start),
					Math.abs(point.offset - node.range.endExclusive),
				);
			}

			// doesn't contain a recent offset -> add distance to the costs
			return 1 + distance + langCost + currentCost;
		},
	});

	// turn into map, filter empty documents
	const map = new Map<string, DocumentProjectionPair>();
	for (let i = 0; i < documents.length; i++) {
		if (isFalsyOrWhitespace(documents[i].text)) {
			continue;
		}
		map.set(input[i].document.uri.toString(), { doc: input[i].document, projectedDoc: documents[i] });
	}

	return map;
}

export class TemporalContextStats extends TelemetryData {
	constructor(
		readonly documentCount: number,
		readonly totalCharLength: number,
	) {
		super();
	}
}

export interface IDocument {
	uri: Uri;
	languageId: string;
}

export type TemporalContextProps = PromptElementProps<{
	/**
	 * Document or documents that will be send along anyways. Those will be ignored from the temporal
	 * context but they will be used to pick "more related" other documents (same language etc).
	 */
	context: (IDocument | TextDocumentSnapshot | NotebookDocumentSnapshot)[];

	includeFilePaths?: boolean;

	location: ChatLocation | true;
}>;

export class TemporalContext extends PromptElement<TemporalContextProps> {

	constructor(
		props: TemporalContextProps,
		@IInstantiationService readonly instantiationService: IInstantiationService,
		@IConfigurationService private readonly configurationService: IConfigurationService,
		@IExperimentationService private readonly experimentationService: IExperimentationService
	) {
		super(props);
	}

	async render(_state: void, sizing: PromptSizing) {

		const enabled = (
			this.props.location === true
			|| (this.props.location === ChatLocation.Editor
				? this.configurationService.getExperimentBasedConfig(ConfigKey.TemporalContextInlineChatEnabled, this.experimentationService)
				: this.configurationService.getExperimentBasedConfig(ConfigKey.TemporalContextEditsEnabled, this.experimentationService)
			)
		);

		if (!enabled) {
			return;
		}

		const documents = await this.instantiationService.invokeFunction(
			summarizeTemporalContext,
			Math.min(sizing.tokenBudget, 32_000),
			this.props.context
		);

		if (documents.size === 0) {
			return;
		}

		return <Tag name='recentDocuments'>
			I have read or edited some files recently. They may be helpful for answering the current question.<br />
			<Tag name='note'>
				These documents are provided as extra insights but are not meant to be edited or changed in any way.
			</Tag>
			{
				Array.from(Iterable.map(documents, ([_, { doc: origDoc, projectedDoc }]) => {
					return <>
						<Tag name={projectedDoc.isOriginal ? 'document' : 'documentFragment'}>
							From `<UriElement value={origDoc.uri} mode={UriMode.Path} />` I have read or edited:<br />
							<CodeBlock includeFilepath={this.props.includeFilePaths} languageId={origDoc.languageId} uri={origDoc.uri} code={projectedDoc.text} />
						</Tag>
						<br />
					</>;
				}))
			}
			<meta value={new TemporalContextStats(
				documents.size,
				Iterable.reduce(documents.values(), (p, { projectedDoc: c }) => p + c.text.length, 0))
			} />
		</Tag>;
	}
}

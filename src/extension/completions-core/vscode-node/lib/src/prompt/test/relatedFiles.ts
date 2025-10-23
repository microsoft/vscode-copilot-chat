/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Context } from '../../context';
import {
	RelatedFilesDocumentInfo,
	RelatedFilesProvider,
	RelatedFilesResponse,
	RelatedFileTrait,
} from '../similarFiles/relatedFiles';
import { TelemetryWithExp } from '../../telemetry';

export class MockTraitsProvider extends RelatedFilesProvider {
	constructor(
		context: Context,
		private readonly traits: RelatedFileTrait[] = [
			{ name: 'testTraitName', value: 'testTraitValue' },
			{ name: 'TargetFrameworks', value: 'net8' },
			{ name: 'LanguageVersion', value: '12' },
		]
	) {
		super(context);
	}

	async getRelatedFilesResponse(
		docInfo: RelatedFilesDocumentInfo,
		telemetryData: TelemetryWithExp
	): Promise<RelatedFilesResponse | undefined> {
		return Promise.resolve({
			entries: [],
			traits: this.traits,
		});
	}
}

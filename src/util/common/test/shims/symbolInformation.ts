/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type * as vscode from 'vscode';
import { URI } from '../../../vs/base/common/uri';
import { Location } from '../../../vs/workbench/api/common/extHostTypes/location';
import { Range } from '../../../vs/workbench/api/common/extHostTypes/range';

export class SymbolInformation {

	static validate(candidate: SymbolInformation): void {
		if (!candidate.name) {
			throw new Error('name must not be falsy');
		}
	}

	name: string;
	location!: Location;
	kind: vscode.SymbolKind;
	containerName: string;

	constructor(name: string, kind: vscode.SymbolKind, containerName: string | undefined, location: Location);
	constructor(name: string, kind: vscode.SymbolKind, range: Range, uri?: URI, containerName?: string);
	constructor(name: string, kind: vscode.SymbolKind, rangeOrContainer: string | undefined | Range, locationOrUri?: Location | URI, containerName?: string) {
		this.name = name;
		this.kind = kind;
		this.containerName = containerName || '';

		if (typeof rangeOrContainer === 'string') {
			this.containerName = rangeOrContainer;
		}

		if (locationOrUri instanceof Location) {
			this.location = locationOrUri;
		} else if (rangeOrContainer instanceof Range) {
			this.location = new Location(locationOrUri!, rangeOrContainer);
		}

		SymbolInformation.validate(this);
	}
}

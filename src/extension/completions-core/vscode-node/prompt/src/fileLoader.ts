/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
import * as fs from 'node:fs/promises';
import path from 'node:path';

export async function readFile(filename: string): Promise<Uint8Array> {
	return await fs.readFile(locateFile(filename));
}

export function locateFile(filename: string): string {
	// construct a path that works both for the TypeScript source, which lives under `/src`, and for
	// the transpiled JavaScript, which lives under `/dist`
	return path.resolve(
		path.extname(__filename) !== '.ts' ? __dirname : path.resolve(__dirname, '../../../../../../dist'),
		filename
	);
}

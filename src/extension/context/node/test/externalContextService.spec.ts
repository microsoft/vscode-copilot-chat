/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as path from 'path';
import { describe, expect, it } from 'vitest';
import { URI } from '../../../../util/vs/base/common/uri';
import { ExternalContextService } from '../externalContextService';

function createUri(name: string): URI {
	return URI.file(path.join(process.cwd(), 'external-context-tests', name));
}

describe('ExternalContextService', () => {
	it('caps at max external paths', () => {
		const service = new ExternalContextService();

		service.addExternalPaths([
			createUri('one'),
			createUri('two'),
			createUri('three'),
			createUri('four')
		]);

		expect(service.getExternalPaths()).toHaveLength(service.maxExternalPaths);
	});

	it('fires change event when paths are added', () => {
		const service = new ExternalContextService();
		let fired = 0;

		service.onDidChangeExternalContext(() => fired++);

		service.addExternalPaths([createUri('one')]);

		expect(fired).toBe(1);
	});

	it('removes paths and fires event', () => {
		const service = new ExternalContextService();
		const [added] = service.addExternalPaths([createUri('one')]);
		let fired = 0;

		service.onDidChangeExternalContext(() => fired++);

		service.removeExternalPath(added);

		expect(service.getExternalPaths()).toHaveLength(0);
		expect(fired).toBe(1);
	});
});


/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Load env
import * as dotenv from 'dotenv';
dotenv.config({ path: '../.env' });

import { outdent } from 'outdent';
import { assert, describe, expect, it } from 'vitest';
import { MutableObservableWorkspace } from '../src/_internal/platform/inlineEdits/common/observableWorkspace';
import { CancellationToken } from '../src/_internal/util/vs/base/common/cancellation';
import { URI } from '../src/_internal/util/vs/base/common/uri';
import { createNESProvider } from '../src/main';
import { DocumentId } from '../src/_internal/platform/inlineEdits/common/dataTypes/documentId';
import { OffsetRange } from '../src/_internal/util/vs/editor/common/core/ranges/offsetRange';
import { StringEdit } from '../src/_internal/util/vs/editor/common/core/edits/stringEdit';


describe('NESProvider Facade', () => {
	it('should handle getNextEdit call with a document URI', async () => {
		const obsWorkspace = new MutableObservableWorkspace();
		const doc = obsWorkspace.addDocument({
			id: DocumentId.create(URI.file('/test/test.ts').toString()),
			initialValue: outdent`
			class Point {
				constructor(
					private readonly x: number,
					private readonly y: number,
				) { }
				getDistance() {
					return Math.sqrt(this.x ** 2 + this.y ** 2);
				}
			}

			const myPoint = new Point(0, 1);`.trimStart()
		});
		doc.setSelection([new OffsetRange(1, 1)], undefined);

		const nextEditProvider = createNESProvider(obsWorkspace);

		doc.applyEdit(StringEdit.insert(11, '3D'));

		const result = await nextEditProvider.getNextEdit(doc.id.toUri(), CancellationToken.None);

		assert(result.result?.edit);

		doc.applyEdit(result.result.edit.toEdit());

		expect(doc.value.get().value).toMatchInlineSnapshot(`
			"class Point3D {
				constructor(
					private readonly x: number,
					private readonly y: number,
					private readonly z: number,
				) { }
				getDistance() {
					return Math.sqrt(this.x ** 2 + this.y ** 2);
				}
			}

			const myPoint = new Point(0, 1);"
		`);
	});
});
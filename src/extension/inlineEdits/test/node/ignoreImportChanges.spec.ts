/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { expect, suite, test } from 'vitest';
import { DiffServiceImpl } from '../../../../platform/diff/node/diffServiceImpl';
import { stringEditFromDiff } from '../../../../platform/editing/common/edit';
import { RootedEdit } from '../../../../platform/inlineEdits/common/dataTypes/edit';
import { StringText } from '../../../../util/vs/editor/common/core/text/abstractText';
import { IgnoreImportChangesAspect } from '../../node/importFiltering';

suite('IgnoreImportChangesAspect', () => {
	const diffService = new DiffServiceImpl();

	async function computeDiff(val1: StringText, val2: StringText): Promise<RootedEdit> {
		const edit = await stringEditFromDiff(val1.value, val2.value, diffService);
		return new RootedEdit(val1, edit);
	}

	const doc1 = new StringText(`
/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { assert } from '../../../util/vs/base/common/assert';
import { CancellationToken } from '../../../util/vs/base/common/cancellation';
import { win32 } from '../../../util/vs/base/common/path';

class FooBar {
}
	`);


	test('ImportDeletion', async () => {
		const doc2 = new StringText(`
/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { assert } from '../../../util/vs/base/common/assert';
import { win32 } from '../../../util/vs/base/common/path';

class FooBar {
}
`);

		const lineEdit = RootedEdit.toLineEdit(await computeDiff(doc1, doc2));
		expect(IgnoreImportChangesAspect.isImportChange(lineEdit.replacements[0], 'typescript', doc1.getLines())).toBe(true);
	});


	test('ImportAddition', async () => {
		const doc2 = new StringText(`
/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { assert } from '../../../util/vs/base/common/assert';
import { assert2 } from '../../../util/vs/base/common/assert2';
import { CancellationToken } from '../../../util/vs/base/common/cancellation';
import { win32 } from '../../../util/vs/base/common/path';

class FooBar {
}
`);

		const lineEdit = RootedEdit.toLineEdit(await computeDiff(doc1, doc2));
		expect(IgnoreImportChangesAspect.isImportChange(lineEdit.replacements[0], 'typescript', doc1.getLines())).toBe(true);
	});

	test('ImportChange', async () => {
		const doc2 = new StringText(`
/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { assert } from '../../../util/vs/base/common/assert';
import { CancellationToken2 } from '../../../util/vs/base/common/cancellation';
import { win32 } from '../../../util/vs/base/common/path';

class FooBar {
}
`);

		const lineEdit = RootedEdit.toLineEdit(await computeDiff(doc1, doc2));
		expect(IgnoreImportChangesAspect.isImportChange(lineEdit.replacements[0], 'typescript', doc1.getLines())).toBe(true);
	});


	test('ClassChange', async () => {
		const doc2 = new StringText(`
/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { assert } from '../../../util/vs/base/common/assert';
import { CancellationToken } from '../../../util/vs/base/common/cancellation';
import { win32 } from '../../../util/vs/base/common/path';

class FooBar {
	test() {}
}
`);

		const lineEdit = RootedEdit.toLineEdit(await computeDiff(doc1, doc2));
		expect(IgnoreImportChangesAspect.isImportChange(lineEdit.replacements[0], 'typescript', doc1.getLines())).toBe(false);
	});
});

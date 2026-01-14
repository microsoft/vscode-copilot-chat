/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { ConfigKey, IConfigurationService } from '../../../../platform/configuration/common/configurationService';
import { ITestingServicesAccessor } from '../../../../platform/test/node/services';
import { DisposableStore } from '../../../../util/vs/base/common/lifecycle';
import { IInstantiationService } from '../../../../util/vs/platform/instantiation/common/instantiation';
import { createExtensionUnitTestingServices } from '../../../test/node/services';
import { ChatContextCounterStatus } from '../chatContextCounterStatus';

class TestChatStatusItem {
	public title: string | { label: string; link: string } = '';
	public description = '';
	public detail: string | undefined = undefined;
	public visible = false;

	constructor(public readonly id: string) { }

	show(): void {
		this.visible = true;
	}

	hide(): void {
		this.visible = false;
	}

	dispose(): void {
		// no-op
	}
}

describe('ChatContextCounterStatus', () => {
	let accessor: ITestingServicesAccessor;
	let instantiationService: IInstantiationService;
	let configurationService: IConfigurationService;
	let disposables: DisposableStore;

	beforeEach(() => {
		disposables = new DisposableStore();
		const services = createExtensionUnitTestingServices(disposables);
		accessor = services.createTestingAccessor();
		instantiationService = accessor.get(IInstantiationService);
		configurationService = accessor.get(IConfigurationService);
	});

	afterEach(() => {
		disposables.dispose();
	});

	test('does not create a status item while disabled', () => {
		const created: TestChatStatusItem[] = [];
		const createChatStatusItem = (id: string) => {
			const item = new TestChatStatusItem(id);
			created.push(item);
			return item;
		};

		const status = instantiationService.createInstance(ChatContextCounterStatus, createChatStatusItem);
		status.update(123, 8192);

		expect(created.length).toBe(0);
	});

	test('creates and updates the status item when enabled', async () => {
		const created: TestChatStatusItem[] = [];
		const createChatStatusItem = (id: string) => {
			const item = new TestChatStatusItem(id);
			created.push(item);
			return item;
		};

		const status = instantiationService.createInstance(ChatContextCounterStatus, createChatStatusItem);

		await configurationService.setConfig(ConfigKey.ContextCounterEnabled, true);
		status.update(100, 1000);

		expect(created.length).toBe(1);
		const item = created[0];
		expect(item.visible).toBe(true);
		expect(item.title).toBe('Context Usage');
		expect(item.description).toBe('100/1.0k (10%)');
	});
});

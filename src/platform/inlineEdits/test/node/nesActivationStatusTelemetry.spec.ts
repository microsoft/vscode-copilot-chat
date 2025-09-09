/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { beforeEach, describe, expect, test, vi } from 'vitest';
import { ConfigKey, IConfigurationService } from '../../../configuration/common/configurationService';
import { IExperimentationService } from '../../../telemetry/common/nullExperimentationService';
import { ITelemetryService } from '../../../telemetry/common/telemetry';
import { NesActivationTelemetryContribution } from '../../common/nesActivationStatusTelemetry.contribution';

describe('NesActivationTelemetryContribution', () => {
	let mockTelemetryService: ITelemetryService;
	let mockConfigurationService: IConfigurationService;
	let mockExperimentationService: IExperimentationService;

	beforeEach(() => {
		mockTelemetryService = {
			sendMSFTTelemetryEvent: vi.fn(),
			sendMSFTTelemetryErrorEvent: vi.fn(),
			dispose: vi.fn(),
			setSharedProperty: vi.fn(),
			postEvent: vi.fn(),
		} as any;

		mockConfigurationService = {
			getConfig: vi.fn().mockReturnValue({ '*': true }),
			isConfigured: vi.fn().mockReturnValue(false),
			getExperimentBasedConfig: vi.fn().mockReturnValue(true),
		} as any;

		mockExperimentationService = {} as any;
	});

	test('should use sendMSFTTelemetryEvent not sendMSFTTelemetryErrorEvent', () => {
		// Act
		new NesActivationTelemetryContribution(
			mockTelemetryService,
			mockConfigurationService,
			mockExperimentationService
		);

		// Assert
		expect(mockTelemetryService.sendMSFTTelemetryEvent).toHaveBeenCalledOnce();
		expect(mockTelemetryService.sendMSFTTelemetryErrorEvent).not.toHaveBeenCalled();
		
		// Verify the call details
		expect(mockTelemetryService.sendMSFTTelemetryEvent).toHaveBeenCalledWith(
			'nesStatusOnActivation',
			{},
			{
				isCompletionsEnabled: 1,
				isCompletionsUserConfigured: 0,
				isNesEnabled: 1,
				isNesUserConfigured: 0,
			}
		);
	});

	test('should send correct telemetry data based on configuration', () => {
		// Arrange
		mockConfigurationService.getConfig = vi.fn().mockReturnValue({ '*': false });
		mockConfigurationService.isConfigured = vi.fn().mockReturnValue(true);
		mockConfigurationService.getExperimentBasedConfig = vi.fn().mockReturnValue(false);

		// Act
		new NesActivationTelemetryContribution(
			mockTelemetryService,
			mockConfigurationService,
			mockExperimentationService
		);

		// Assert
		expect(mockTelemetryService.sendMSFTTelemetryEvent).toHaveBeenCalledWith(
			'nesStatusOnActivation',
			{},
			{
				isCompletionsEnabled: 0,
				isCompletionsUserConfigured: 1,
				isNesEnabled: 0,
				isNesUserConfigured: 1,
			}
		);
	});
});
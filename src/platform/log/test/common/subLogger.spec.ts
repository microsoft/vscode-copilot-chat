/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { beforeEach, describe, expect, test } from 'vitest';
import { LogLevel, LogServiceImpl } from '../../common/logService';
import { TestLogTarget } from './loggerHelpers';

describe('SubLogger', () => {
	let logTarget: TestLogTarget;
	let logService: LogServiceImpl;

	beforeEach(() => {
		logTarget = new TestLogTarget();
		logService = new LogServiceImpl([logTarget]);
	});

	describe('prefix formatting', () => {
		test('prefixes messages with single topic', () => {
			const subLogger = logService.createSubLogger('Feature');
			subLogger.info('test message');
			logTarget.assertHasMessage(LogLevel.Info, '[Feature] test message');
		});

		test('prefixes messages with array of topics', () => {
			const subLogger = logService.createSubLogger(['NES', 'Feature']);
			subLogger.info('test message');
			logTarget.assertHasMessage(LogLevel.Info, '[NES][Feature] test message');
		});

		test('handles empty array of topics', () => {
			const subLogger = logService.createSubLogger([]);
			subLogger.info('test message');
			logTarget.assertHasMessage(LogLevel.Info, ' test message');
		});
	});

	describe('nested sub-loggers', () => {
		test('accumulates prefixes when nesting sub-loggers', () => {
			const parentLogger = logService.createSubLogger('Parent');
			const childLogger = parentLogger.createSubLogger('Child');
			childLogger.info('nested message');
			logTarget.assertHasMessage(LogLevel.Info, '[Parent][Child] nested message');
		});

		test('supports multiple levels of nesting', () => {
			const level1 = logService.createSubLogger('L1');
			const level2 = level1.createSubLogger('L2');
			const level3 = level2.createSubLogger('L3');
			level3.info('deeply nested');
			logTarget.assertHasMessage(LogLevel.Info, '[L1][L2][L3] deeply nested');
		});

		test('accumulates array topics when nesting', () => {
			const parentLogger = logService.createSubLogger(['A', 'B']);
			const childLogger = parentLogger.createSubLogger(['C', 'D']);
			childLogger.info('message');
			logTarget.assertHasMessage(LogLevel.Info, '[A][B][C][D] message');
		});
	});

	describe('logging methods', () => {
		test('trace method prefixes correctly', () => {
			const subLogger = logService.createSubLogger('Test');
			subLogger.trace('trace message');
			logTarget.assertHasMessage(LogLevel.Trace, '[Test] trace message');
		});

		test('debug method prefixes correctly', () => {
			const subLogger = logService.createSubLogger('Test');
			subLogger.debug('debug message');
			logTarget.assertHasMessage(LogLevel.Debug, '[Test] debug message');
		});

		test('info method prefixes correctly', () => {
			const subLogger = logService.createSubLogger('Test');
			subLogger.info('info message');
			logTarget.assertHasMessage(LogLevel.Info, '[Test] info message');
		});

		test('warn method prefixes correctly', () => {
			const subLogger = logService.createSubLogger('Test');
			subLogger.warn('warn message');
			logTarget.assertHasMessage(LogLevel.Warning, '[Test] warn message');
		});

		test('error method with message prefixes correctly', () => {
			const subLogger = logService.createSubLogger('Test');
			const error = new Error('test error');
			subLogger.error(error, 'error context');
			// The error method formats as: collectErrorMessages(error) + ': ' + prefixedMessage
			// The 's' flag makes '.' match newlines
			expect(logTarget.hasMessageMatching(LogLevel.Error, /test error.*\[Test\] error context/s)).toBe(true);
		});

		test('error method without message uses prefix only', () => {
			const subLogger = logService.createSubLogger('Test');
			const error = new Error('test error');
			subLogger.error(error);
			// The error method formats as: collectErrorMessages(error) + ': ' + prefix
			expect(logTarget.hasMessageMatching(LogLevel.Error, /test error.*\[Test\]/s)).toBe(true);
		});

		test('error method with string error and message', () => {
			const subLogger = logService.createSubLogger('Test');
			subLogger.error('string error', 'error context');
			// The error method formats as: error + ': ' + prefixedMessage
			expect(logTarget.hasMessageMatching(LogLevel.Error, /string error.*\[Test\] error context/s)).toBe(true);
		});
	});

	describe('show method', () => {
		test('delegates show to parent logger', () => {
			let showCalled = false;
			let preserveFocusValue: boolean | undefined = undefined;

			const mockTarget: TestLogTarget & { show: (preserveFocus?: boolean) => void } = Object.assign(
				new TestLogTarget(),
				{
					show(preserveFocus?: boolean) {
						showCalled = true;
						preserveFocusValue = preserveFocus;
					}
				}
			);

			const service = new LogServiceImpl([mockTarget]);
			const subLogger = service.createSubLogger('Test');
			subLogger.show(true);

			expect(showCalled).toBe(true);
			expect(preserveFocusValue).toBe(true);
		});
	});

	describe('independence of sub-loggers', () => {
		test('sibling sub-loggers do not affect each other', () => {
			const logger1 = logService.createSubLogger('Logger1');
			const logger2 = logService.createSubLogger('Logger2');

			logger1.info('message from 1');
			logger2.info('message from 2');

			logTarget.assertHasMessage(LogLevel.Info, '[Logger1] message from 1');
			logTarget.assertHasMessage(LogLevel.Info, '[Logger2] message from 2');
		});

		test('parent and child sub-loggers work independently', () => {
			const parent = logService.createSubLogger('Parent');
			const child = parent.createSubLogger('Child');

			parent.info('parent message');
			child.info('child message');

			logTarget.assertHasMessage(LogLevel.Info, '[Parent] parent message');
			logTarget.assertHasMessage(LogLevel.Info, '[Parent][Child] child message');
		});
	});
});

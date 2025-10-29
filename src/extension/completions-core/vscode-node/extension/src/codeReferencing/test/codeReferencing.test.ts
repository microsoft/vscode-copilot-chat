/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
import * as assert from 'assert';
import * as Sinon from 'sinon';
import { Disposable, ExtensionContext } from 'vscode';
import { CodeReference } from '..';
import { CopilotToken } from '../../../../../../../platform/authentication/common/copilotToken';
import type { ICompletionsContextService } from '../../../../lib/src/context';
import { ConnectionState } from '../../../../lib/src/snippy/connectionState';
import { Extension } from '../../extensionContext';
import { createExtensionTestingContext } from '../../test/context';

function testExtensionContext() {
	return {
		subscriptions: [],
	};
}

suite('CodeReference', function () {
	let extensionContext: ExtensionContext;
	let context: ICompletionsContextService;
	let sub: Disposable | undefined;

	setup(function () {
		context = createExtensionTestingContext();
		extensionContext = testExtensionContext() as unknown as ExtensionContext;
		context.set(Extension, new Extension(extensionContext));
	});

	teardown(function () {
		extensionContext.subscriptions.forEach(sub => {
			sub.dispose();
		});
		sub?.dispose();
		ConnectionState.setDisabled();
	});

	suite('subscriptions', function () {
		test('should be undefined by default', function () {
			const result = context.instantiationService.createInstance(CodeReference);
			sub = result.subscriptions;
			assert.ok(!sub);
		});

		test('should be updated correctly when token change events received', function () {
			const codeQuote = context.instantiationService.createInstance(CodeReference);
			const enabledToken = new CopilotToken({ token: this._completionsToken, expires_at: 0, refresh_in: 0, username: 'fixedTokenManager', isVscodeTeamMember: false, copilot_plan: 'unknown', code_quote_enabled: true });
			const disabledToken = new CopilotToken({ token: this._completionsToken, expires_at: 0, refresh_in: 0, username: 'fixedTokenManager', isVscodeTeamMember: false, copilot_plan: 'unknown', code_quote_enabled: false });

			codeQuote.onCopilotToken(enabledToken);

			assert.ok(codeQuote.enabled);
			assert.ok(codeQuote.subscriptions);
			assert.ok(codeQuote.subscriptions instanceof Disposable);

			const subSpy = Sinon.spy(codeQuote.subscriptions, 'dispose');
			codeQuote.onCopilotToken(disabledToken);

			assert.ok(!codeQuote.enabled);
			assert.strictEqual(codeQuote.subscriptions, undefined);
			assert.strictEqual(subSpy.calledOnce, true);

			codeQuote.onCopilotToken(enabledToken);
			assert.ok(codeQuote.enabled);
			assert.notStrictEqual(codeQuote.subscriptions, undefined);
		});
	});
});

/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
import { InputBoxOptions, QuickInputButtons, window } from 'vscode';
import { DisposableStore } from '../../../util/vs/base/common/lifecycle';

type BackButtonClick = { back: true };
export function isBackButtonClick(value: unknown): value is BackButtonClick {
	return typeof value === 'object' && (value as BackButtonClick)?.back === true;
}


// Helper function for creating an input box with a back button
function createInputBoxWithBackButton(options: InputBoxOptions, hideBackButton?: boolean): Promise<string | BackButtonClick | undefined> {
	const disposableStore = new DisposableStore();
	const inputBox = disposableStore.add(window.createInputBox());
	inputBox.ignoreFocusOut = true;
	inputBox.title = options.title;
	inputBox.password = options.password || false;
	inputBox.prompt = options.prompt;
	inputBox.placeholder = options.placeHolder;
	inputBox.value = options.value || '';
	inputBox.buttons = hideBackButton ? [] : [QuickInputButtons.Back];

	return new Promise<string | BackButtonClick | undefined>(resolve => {
		disposableStore.add(inputBox.onDidTriggerButton(button => {
			if (button === QuickInputButtons.Back) {
				resolve({ back: true });
				disposableStore.dispose();
			}
		}));

		disposableStore.add(inputBox.onDidAccept(async () => {
			const value = inputBox.value;
			if (options.validateInput) {
				const validation = options.validateInput(value);
				if (validation) {
					// Show validation message but don't hide
					inputBox.validationMessage = (await validation) || undefined;
					return;
				}
			}
			resolve(value);
			disposableStore.dispose();
		}));

		disposableStore.add(inputBox.onDidHide(() => {
			// This resolves undefined if the input box is dismissed without accepting
			resolve(undefined);
			disposableStore.dispose();
		}));

		inputBox.show();
	});
}


export async function promptForAPIKey(contextName: string, reconfigure: boolean = false): Promise<string | undefined> {
	const prompt = reconfigure ? `Enter new ${contextName} API Key or leave blank to delete saved key` : `Enter ${contextName} API Key`;
	const title = reconfigure ? `Reconfigure ${contextName} API Key - Preview` : `Enter ${contextName} API Key - Preview`;

	const result = await createInputBoxWithBackButton({
		prompt: prompt,
		title: title,
		placeHolder: `${contextName} API Key`,
		ignoreFocusOut: true,
		password: true,
		validateInput: (value) => {
			// Allow empty input only when reconfiguring (to delete the key)
			return (value.trim().length > 0 || reconfigure) ? null : 'API Key cannot be empty';
		}
	}, true);

	if (isBackButtonClick(result)) {
		return undefined;
	}

	return result;
}
/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
import { BasePromptElementProps, PromptElement, PromptPiece } from '@vscode/prompt-tsx';

interface CustomRenderProps<T extends { [key: string]: (args: any) => PromptElement | PromptPiece }, K extends keyof T> extends BasePromptElementProps {
	id: K;
	overrides?: T;
	args?: Parameters<T[K]>[0];
}

export class CustomRender<
	T extends { [key: string]: (args: any) => PromptElement | PromptPiece },
	K extends keyof T = keyof T
> extends PromptElement<CustomRenderProps<T, K>> {
	constructor(props: CustomRenderProps<T, K>) {
		super(props);
	}

	render() {
		if (this.props.overrides && Object.hasOwn(this.props.overrides, this.props.id)) {
			return this.props.overrides[this.props.id](this.props.args);
		}
		return <>{this.props.children}</>;
	}
}

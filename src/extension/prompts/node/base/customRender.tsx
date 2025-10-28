/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
import { BasePromptElementProps, PromptElement, PromptPiece } from '@vscode/prompt-tsx';

interface CustomRenderProps<T> extends BasePromptElementProps {
	id: keyof T;
	overrides?: T;
}

export class CustomRender<
	T = Record<string, () => PromptElement | PromptPiece>
> extends PromptElement<CustomRenderProps<T>> {
	constructor(props: CustomRenderProps<T>) {
		super(props);
	}

	render() {
		if (this.props.overrides && Object.hasOwn(this.props.overrides, this.props.id)) {
			return this.props.overrides[this.props.id];
		}
		return <>{this.props.children}</>;
	}
}

/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { BasePromptElementProps, PromptElement, Raw } from '@vscode/prompt-tsx';
import { CustomDataPartMimeTypes } from './endpointTypes';

/**
 * A type representing a stateful marker that can be stored in an opaque part in raw chat messages.
 */
interface IStatefulMarkerContainer {
	type: typeof CustomDataPartMimeTypes.StatefulMarker;
	value: string;
}

export interface IStatefulMarkerContainerProps extends BasePromptElementProps {
	statefulMarker: string;
}

/**
 * Helper to store the statefulMarker as part of a prompt-tsx assistant message
 */
export class StatefulMarkerContainer extends PromptElement<IStatefulMarkerContainerProps> {
	render() {
		const { statefulMarker } = this.props;
		const container = { type: CustomDataPartMimeTypes.StatefulMarker, value: statefulMarker };
		return <opaque value={container} />;
	}
}

/**
 * Check whether an opaque content part is a StatefulMarkerContainer and retrieve the stateful marker if so
 */
export function rawPartAsStatefulMarker(part: Raw.ChatCompletionContentPartOpaque): string | undefined {
	const value = part.value;
	if (!value || typeof value !== 'object') {
		return;
	}

	const data = value as IStatefulMarkerContainer;
	if (data.type === CustomDataPartMimeTypes.StatefulMarker && typeof data.value === 'string') {
		return data.value;
	}
	return;
}

export function getStatefulMarkerAndIndex(messages: readonly Raw.ChatMessage[]): { statefulMarker: string; index: number } | undefined {
	for (let idx = messages.length - 1; idx >= 0; idx--) {
		const message = messages[idx];
		if (message.role === Raw.ChatRole.Assistant) {
			for (const part of message.content) {
				if (part.type === Raw.ChatCompletionContentPartKind.Opaque) {
					const statefulMarker = rawPartAsStatefulMarker(part);
					if (statefulMarker) {
						return { statefulMarker, index: idx };
					}
				}
			}
		}
	}
	return undefined;
}
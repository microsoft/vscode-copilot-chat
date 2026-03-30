/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { BasePromptElementProps, PromptElement, Raw } from '@vscode/prompt-tsx';
import { CustomDataPartMimeTypes } from './endpointTypes';

interface IResponseOutputMessageIdOpaque {
	type: typeof CustomDataPartMimeTypes.ResponseOutputMessageId;
	responseOutputMessageId: string;
}

interface ILegacyPhaseDataOpaque {
	type: typeof CustomDataPartMimeTypes.PhaseData;
	responseOutputMessageId?: string;
}

export interface IResponseOutputMessageIdContainerProps extends BasePromptElementProps {
	responseOutputMessageId: string;
}

/**
 * Helper element to embed a Responses API output message ID into assistant messages
 * as an opaque content part.
 */
export class ResponseOutputMessageIdContainer extends PromptElement<IResponseOutputMessageIdContainerProps> {
	render() {
		const { responseOutputMessageId } = this.props;
		const container: IResponseOutputMessageIdOpaque = {
			type: CustomDataPartMimeTypes.ResponseOutputMessageId,
			responseOutputMessageId,
		};
		return <opaque value={container} />;
	}
}

/**
 * Attempts to parse a Raw opaque content part into a Responses API output message ID.
 * Falls back to legacy phase payloads that stored the ID alongside the phase.
 */
export function rawPartAsResponseOutputMessageId(part: Raw.ChatCompletionContentPartOpaque): string | undefined {
	const value = part.value as unknown;
	if (!value || typeof value !== 'object') {
		return;
	}

	const data = value as IResponseOutputMessageIdOpaque | ILegacyPhaseDataOpaque;
	if (
		data.type === CustomDataPartMimeTypes.ResponseOutputMessageId
		&& typeof data.responseOutputMessageId === 'string'
	) {
		return data.responseOutputMessageId;
	}

	if (
		data.type === CustomDataPartMimeTypes.PhaseData
		&& typeof data.responseOutputMessageId === 'string'
	) {
		return data.responseOutputMessageId;
	}

	return;
}

export function encodeResponseOutputMessageId(responseOutputMessageId: string): Uint8Array {
	return new TextEncoder().encode(responseOutputMessageId);
}

export function decodeResponseOutputMessageId(data: Uint8Array): string {
	const decoded = new TextDecoder().decode(data);
	try {
		const parsed = JSON.parse(decoded) as Partial<
			IResponseOutputMessageIdOpaque
		>;
		if (typeof parsed.responseOutputMessageId === 'string') {
			return parsed.responseOutputMessageId;
		}
	} catch {
		// Backward compatibility with plain string payloads.
	}

	return decoded;
}
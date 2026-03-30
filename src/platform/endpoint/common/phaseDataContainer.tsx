/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
import { BasePromptElementProps, PromptElement, Raw } from '@vscode/prompt-tsx';
import { CustomDataPartMimeTypes } from './endpointTypes';

export interface IPhaseData {
	phase: string;
	responseOutputMessageId?: string;
}

interface IPhaseDataOpaque extends IPhaseData {
	type: typeof CustomDataPartMimeTypes.PhaseData;
}

export interface IPhaseDataContainerProps extends BasePromptElementProps {
	phase: string;
}

/**
 * Helper element to embed phase data into assistant messages
 * as an opaque content part.
 */
export class PhaseDataContainer extends PromptElement<IPhaseDataContainerProps> {
	render() {
		const { phase } = this.props;
		const container: IPhaseDataOpaque = { type: CustomDataPartMimeTypes.PhaseData, phase };
		return <opaque value={container} />;
	}
}

/**
 * Attempts to parse a Raw opaque content part into phase metadata, if the type matches.
 */
export function rawPartAsPhaseData(part: Raw.ChatCompletionContentPartOpaque): IPhaseData | undefined {
	const value = part.value as unknown;
	if (!value || typeof value !== 'object') {
		return;
	}

	const data = value as IPhaseDataOpaque;
	if (data.type === CustomDataPartMimeTypes.PhaseData && typeof data.phase === 'string') {
		return {
			phase: data.phase,
			responseOutputMessageId: typeof data.responseOutputMessageId === 'string' ? data.responseOutputMessageId : undefined,
		};
	}
	return;
}

export function encodePhaseData(phaseData: IPhaseData): Uint8Array {
	return new TextEncoder().encode(JSON.stringify(phaseData));
}

export function decodePhaseData(data: Uint8Array): IPhaseData {
	const decoded = new TextDecoder().decode(data);
	try {
		const parsed = JSON.parse(decoded) as Partial<IPhaseData>;
		if (typeof parsed.phase === 'string') {
			return {
				phase: parsed.phase,
				responseOutputMessageId: typeof parsed.responseOutputMessageId === 'string' ? parsed.responseOutputMessageId : undefined,
			};
		}
	} catch {
		// Backward compatibility with older data parts that encoded only the phase string.
	}

	return { phase: decoded };
}

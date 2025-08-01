/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { ThinkingDelta } from '../../thinking/common/thinking';
import { Response } from './fetcherService';
import { ChoiceLogProbs, FilterReason } from './openai';


// Request helpers

export interface RequestId {
	headerRequestId: string;
	completionId: string;
	created: number;
	serverExperiments: string;
	deploymentId: string;
}

export function getRequestId(response: Response, json?: any): RequestId {
	return {
		headerRequestId: response.headers.get('x-request-id') || '',
		completionId: json && json.id ? json.id : '',
		created: json && json.created ? json.created : 0,
		serverExperiments: response.headers.get('X-Copilot-Experiment') || '',
		deploymentId: response.headers.get('azureml-model-deployment') || '',
	};
}

export function getProcessingTime(response: Response): number {
	const reqIdStr = response.headers.get('openai-processing-ms');
	if (reqIdStr) {
		return parseInt(reqIdStr, 10);
	}
	return 0;
}

// Request methods

export interface ICodeVulnerabilityAnnotation {
	details: {
		type: string;
		description: string;
	};
}

export interface IIPCodeCitation {
	citations: {
		url: string;
		license: string;
		snippet: string;
	};
}

export function isCopilotAnnotation(thing: unknown): thing is ICodeVulnerabilityAnnotation {
	if (typeof thing !== 'object' || thing === null || !('details' in thing)) {
		return false;
	}

	const { details } = thing as ICodeVulnerabilityAnnotation;
	return typeof details === 'object' && details !== null &&
		'type' in details && 'description' in details && typeof details.type === 'string' && typeof details.description === 'string';
}

export function isCodeCitationAnnotation(thing: unknown): thing is IIPCodeCitation {
	if (typeof thing !== 'object' || thing === null || !('citations' in thing)) {
		return false;
	}

	const { citations } = thing as IIPCodeCitation;
	return typeof citations === 'object' && citations !== null &&
		'url' in citations && 'license' in citations && typeof citations.url === 'string' && typeof citations.license === 'string';
}

export interface ICopilotReference {
	type: string;
	id: string;
	data: Record<string, unknown>;
	metadata?: {
		display_name: string;
		display_icon?: string;
		display_url?: string;
	};
}

export interface ICopilotToolCall {
	name: string;
	arguments: string;
	id: string;
}

export interface ICopilotBeginToolCall {
	name: string;
}

/**
 * @deprecated
 */
export interface ICopilotFunctionCall {
	name: string;
	arguments: string;
}

export interface ICopilotError {
	type: string;
	code: string;
	message: string;
	agent: string;
	identifier?: string;
}

export interface ICopilotKnowledgeBaseReference {
	type: 'github.knowledge-base';
	id: string;
	data: {
		type: 'knowledge-base';
		id: string;
	};
}

export function isCopilotWebReference(reference: unknown) {
	return typeof reference === 'object' && !!reference && 'title' in reference && 'excerpt' in reference && 'url' in reference;
}

export interface ICopilotWebReference {
	title: string;
	excerpt: string;
	url: string;
}

export interface ICopilotConfirmation {
	title: string;
	message: string;
	confirmation: any;
}

export interface IResponseDelta {
	text: string;
	logprobs?: ChoiceLogProbs;
	codeVulnAnnotations?: ICodeVulnerabilityAnnotation[];
	ipCitations?: IIPCodeCitation[];
	copilotReferences?: ICopilotReference[];
	copilotErrors?: ICopilotError[];
	copilotToolCalls?: ICopilotToolCall[];
	beginToolCalls?: ICopilotBeginToolCall[];
	_deprecatedCopilotFunctionCalls?: ICopilotFunctionCall[];
	copilotConfirmation?: ICopilotConfirmation;
	thinking?: ThinkingDelta;
	retryReason?: FilterReason;
}

export interface FinishedCallback {
	/**
	 * @param text The full concatenated text of the response
	 * @param index The index of the choice to which the completion chunk belongs
	 * @param delta A delta for the latest chunk
	 * @returns A number to stop reading data from the server, `undefined` to continue
	 */
	(text: string, index: number, delta: IResponseDelta): Promise<number | undefined>;
}

export interface OpenAiFunctionDef {
	name: string;
	description: string;
	parameters?: object;
}

export interface OpenAiFunctionTool {
	function: OpenAiFunctionDef;
	type: 'function';
}

/**
 * Options for streaming response. Only set this when you set stream: true.
 *
 * @remarks Proxy has `include_usage` hard-coded to true.
 */
export type StreamOptions = {
	/**
	 * If set, an additional chunk will be streamed before the data: [DONE] message. The usage field on this chunk shows the token usage statistics for the entire request, and the choices field will always be an empty array.
	 *
	 * All other chunks will also include a usage field, but with a null value. NOTE: If the stream is interrupted, you may not receive the final usage chunk which contains the total token usage for the request.
	 */
	include_usage?: boolean;
}

export type Prediction = {
	type: 'content';
	content: string | { type: string; text: string }[];
}

/** based on https://platform.openai.com/docs/api-reference/chat/create
 *
 * 'stream' param is not respected because we don't yet support non-streamed responses
 */
export interface OptionalChatRequestParams {

	/** Non-negative temperature sampling parameter (default 1). */
	temperature?: number;

	/** Non-negative temperature sampling parameter (default 1). */
	top_p?: number;

	/** How many parallel completions the model should generate (default 1). */
	n?: number;

	/** Whether to stream back a response in SSE format. */
	stream?: boolean;

	/** Options for streaming response. Only set this when you set stream: true. */
	stream_options?: StreamOptions;

	/** Strings that will cause the model to stop generating text. */
	stop?: string[];

	/** The maximum number of tokens to return for a completion request */
	max_tokens?: number;

	/** Likelihood of specified tokens appearing in the completion. */
	logit_bias?: number;

	// TODO@ulugbekna: not sure params below are supported by Copilot proxy
	presence_penalty?: number;
	frequency_penalty?: number;

	secretKey?: string;

	/** For github remote agents */
	copilot_thread_id?: string;
	copilot_skills?: string[];

	functions?: OpenAiFunctionDef[];
	function_call?: { name: string };
	tools?: OpenAiFunctionTool[];
	/**
	 * Note: 'required' is not supported
	 */
	tool_choice?: 'none' | 'auto' | { type: 'function'; function: { name: string } };

	prediction?: Prediction;
	logprobs?: boolean;
}

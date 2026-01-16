/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { RequestType } from '@vscode/copilot-api';
import * as l10n from '@vscode/l10n';
import { Image as BaseImage, BasePromptElementProps, ChatResponseReferencePartStatusKind, PromptElement, PromptReference, PromptSizing, UserMessage } from '@vscode/prompt-tsx';
import { IAuthenticationService } from '../../../../platform/authentication/common/authentication';
import { ConfigKey, IConfigurationService } from '../../../../platform/configuration/common/configurationService';
import { GEMINI_SUPPORTED_IMAGE_MIME_TYPES, modelCanUseImageURL, modelSupportsImageMimeType } from '../../../../platform/endpoint/common/chatModelCapabilities';
import { IImageService } from '../../../../platform/image/common/imageService';
import { ILogService } from '../../../../platform/log/common/logService';
import { IExperimentationService } from '../../../../platform/telemetry/common/nullExperimentationService';
import { getMimeType } from '../../../../util/common/imageUtils';
import { Uri } from '../../../../vscodeTypes';
import { IPromptEndpoint } from '../base/promptRenderer';

export interface ImageProps extends BasePromptElementProps {
	variableName: string;
	variableValue: Uint8Array | Promise<Uint8Array>;
	omitReferences?: boolean;
	reference?: Uri;
}

/**
 * Extract the format name from a MIME type string
 * @param mimeType The MIME type (e.g., 'image/png')
 * @returns The format name in uppercase (e.g., 'PNG'), or 'UNKNOWN' if invalid
 */
function getFormatFromMimeType(mimeType: string | undefined): string {
	if (!mimeType) {
		return 'UNKNOWN';
	}
	const parts = mimeType.split('/');
	return parts.length === 2 && parts[1] ? parts[1].toUpperCase() : 'UNKNOWN';
}

export class Image extends PromptElement<ImageProps, unknown> {
	constructor(
		props: ImageProps,
		@IPromptEndpoint private readonly promptEndpoint: IPromptEndpoint,
		@IAuthenticationService private readonly authService: IAuthenticationService,
		@ILogService private readonly logService: ILogService,
		@IImageService private readonly imageService: IImageService,
		@IConfigurationService private readonly configurationService: IConfigurationService,
		@IExperimentationService private readonly experimentationService: IExperimentationService
	) {
		super(props);
	}

	override async render(_state: unknown, sizing: PromptSizing) {
		const options = { status: { description: l10n.t("{0} does not support images.", this.promptEndpoint.model), kind: ChatResponseReferencePartStatusKind.Omitted } };

		const fillerUri: Uri = this.props.reference ?? Uri.parse('Attached Image');

		try {
			if (!this.promptEndpoint.supportsVision) {
				if (this.props.omitReferences) {
					return;
				}

				return (
					<>
						<references value={[new PromptReference(this.props.variableName ? { variableName: this.props.variableName, value: fillerUri } : fillerUri, undefined, options)]} />
					</>
				);
			}
			const variable = await this.props.variableValue;
			let imageSource = Buffer.from(variable).toString('base64');
			let imageMimeType: string | undefined = getMimeType(imageSource);

			// Check if the model supports this image format
			if (imageMimeType && !modelSupportsImageMimeType(this.promptEndpoint, imageMimeType)) {
				// Generate user-friendly format names from MIME types
				const supportedFormats = GEMINI_SUPPORTED_IMAGE_MIME_TYPES
					.map(getFormatFromMimeType)
					.join(', ');

				const unsupportedOptions = {
					status: {
						description: l10n.t("{0} does not support {1} images. Supported formats: {2}.", this.promptEndpoint.model, getFormatFromMimeType(imageMimeType), supportedFormats),
						kind: ChatResponseReferencePartStatusKind.Omitted
					}
				};

				if (this.props.omitReferences) {
					return;
				}

				return (
					<>
						<references value={[new PromptReference(this.props.variableName ? { variableName: this.props.variableName, value: fillerUri } : fillerUri, undefined, unsupportedOptions)]} />
					</>
				);
			}

			const isChatCompletions = typeof this.promptEndpoint.urlOrRequestMetadata !== 'string' && this.promptEndpoint.urlOrRequestMetadata.type === RequestType.ChatCompletions;
			const enabled = this.configurationService.getExperimentBasedConfig(ConfigKey.EnableChatImageUpload, this.experimentationService);
			if (isChatCompletions && enabled && modelCanUseImageURL(this.promptEndpoint) && imageMimeType) {
				try {
					const githubToken = (await this.authService.getGitHubSession('any', { silent: true }))?.accessToken;
					const uri = await this.imageService.uploadChatImageAttachment(variable, this.props.variableName, imageMimeType, githubToken);
					if (uri) {
						imageSource = uri.toString();
					}
				} catch (error) {
					this.logService.warn(`Image upload failed, using base64 fallback: ${error}`);
				}
			}

			return (
				<UserMessage priority={0}>
					<BaseImage src={imageSource} detail='high' mimeType={imageMimeType} />
					{this.props.reference && (
						<references value={[new PromptReference(this.props.variableName ? { variableName: this.props.variableName, value: fillerUri } : fillerUri, undefined)]} />
					)}
				</UserMessage>
			);
		} catch (err) {
			if (this.props.omitReferences) {
				return;
			}

			return (
				<>
					<references value={[new PromptReference(this.props.variableName ? { variableName: this.props.variableName, value: fillerUri } : fillerUri, undefined, options)]} />
				</>);
		}
	}
}

/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { RequestType } from '@vscode/copilot-api';
import { URI } from '../../../util/vs/base/common/uri';
import { ICAPIClientService } from '../../endpoint/common/capiClient';
import { IImageService } from '../common/imageService';

export class ImageServiceImpl implements IImageService {
	declare readonly _serviceBrand: undefined;

	constructor(
		@ICAPIClientService private readonly capiClient: ICAPIClientService,
	) { }

	async uploadChatImageAttachment(binaryData: Uint8Array, name: string, mimeType: string | undefined, token: string | undefined): Promise<URI> {
		if (!mimeType || !token) {
			throw new Error('Missing required mimeType or token for image upload');
		}

		const sanitizedName = name.replace(/\s+/g, '').replace(/%20/g, '');
		let uploadName = sanitizedName;
		const subtype = mimeType.split('/')[1].split('+')[0].toLowerCase();
		if (!uploadName.toLowerCase().endsWith(`.${subtype}`)) {
			uploadName = `${uploadName}.${subtype}`;
		}

		try {
			const response = await this.capiClient.makeRequest<Response>({
				method: 'POST',
				body: binaryData,
				headers: {
					'Content-Type': 'application/octet-stream',
					Authorization: `Bearer ${token}`,
				}
			}, { type: RequestType.ChatAttachmentUpload, uploadName, mimeType });
			if (!response.ok) {
				throw new Error(`Invalid GitHub URL provided: ${response.status} ${response.statusText}`);
			}
			const result = await response.json() as { url: string };
			return URI.parse(result.url);
		} catch (error) {
			throw new Error(`Error uploading image: ${error}`);
		}
	}
}

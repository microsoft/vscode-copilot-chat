/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { RequestType } from '@vscode/copilot-api';
import { createServiceIdentifier } from '../../../util/common/services';
import { IAuthenticationService } from '../../authentication/common/authentication';
import { ICAPIClientService } from '../../endpoint/common/capiClient';
import { ILogService } from '../../log/common/logService';

export const IOrgCustomInstructionsService = createServiceIdentifier<IOrgCustomInstructionsService>('IOrgCustomInstructionsService');

export interface IOrgCustomInstructionsService {
	readonly _serviceBrand: undefined;

	/**
	 * Fetches custom instructions for the current active GitHub organization
	 * @returns The custom instructions as a string, or undefined if not available
	 */
	getOrgCustomInstructions(): Promise<string | undefined>;
}

export class OrgCustomInstructionsService implements IOrgCustomInstructionsService {
	readonly _serviceBrand: undefined;

	constructor(
		@ICAPIClientService private readonly _capiClientService: ICAPIClientService,
		@IAuthenticationService private readonly _authenticationService: IAuthenticationService,
		@ILogService private readonly _logService: ILogService,
	) { }

	async getOrgCustomInstructions(): Promise<string | undefined> {
		try {
			// Get the copilot token to access organization info
			const copilotToken = await this._authenticationService.getCopilotToken();
			if (!copilotToken) {
				this._logService.debug('[OrgCustomInstructions] No copilot token found');
				return undefined;
			}

			// Check for numeric organization ID from enterprise list first (preferred)
			let organizationId: number | undefined;
			if (copilotToken.enterpriseList && copilotToken.enterpriseList.length > 0) {
				organizationId = copilotToken.enterpriseList[0];
				this._logService.debug(`[OrgCustomInstructions] Using enterprise ID: ${organizationId}`);
			} else if (copilotToken.organizationList && copilotToken.organizationList.length > 0) {
				// Try to parse the organization ID from the organization list (hash-based IDs)
				// Note: The organizationList contains hash strings, not numeric IDs
				// For the example request showing organization_id: 12345, this would need to come from
				// a different source or API that maps org names to numeric IDs
				const orgHash = copilotToken.organizationList[0];
				this._logService.debug(`[OrgCustomInstructions] Organization hash found: ${orgHash}`);
				this._logService.warn('[OrgCustomInstructions] Cannot convert organization hash to numeric ID. Numeric organization ID required.');
				return undefined;
			} else {
				this._logService.debug('[OrgCustomInstructions] No organization or enterprise ID found in copilot token');
				return undefined;
			}

			this._logService.debug(`[OrgCustomInstructions] Fetching instructions for organization ID: ${organizationId}`);

			const response = await this._capiClientService.makeRequest<Response>(
				{
					method: 'POST',
					json: { organization_id: organizationId },
					headers: { 'Content-Type': 'application/json' }
				},
				{ type: RequestType.OrgCustomInstructions, organizationId }
			);

			if (!response.ok) {
				this._logService.warn(`[OrgCustomInstructions] Failed to fetch instructions: ${response.status} ${response.statusText}`);
				return undefined;
			}

			const data = await response.json();

			// Assuming the API returns an object with an 'instructions' field
			if (typeof data === 'object' && data !== null && 'instructions' in data && typeof data.instructions === 'string') {
				this._logService.debug(`[OrgCustomInstructions] Successfully fetched instructions (${data.instructions.length} chars)`);
				return data.instructions;
			}

			this._logService.warn('[OrgCustomInstructions] Unexpected response format from API');
			return undefined;

		} catch (error) {
			this._logService.error(`[OrgCustomInstructions] Error fetching organization custom instructions: ${error}`);
			return undefined;
		}
	}
}

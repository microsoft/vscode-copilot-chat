/*---------------------------------------------------------------------------------------------
 *  Null Automode Service
 *  Replaces AutomodeService which calls GitHub CAPI /models/session endpoint.
 *  Simply picks the first available endpoint as the "auto" choice.
 *--------------------------------------------------------------------------------------------*/

import { IChatEndpoint } from '../../networking/common/networking';
import { IAutomodeService } from '../../endpoint/node/automodeService';

export class NullAutomodeService implements IAutomodeService {

	declare readonly _serviceBrand: undefined;

	async resolveAutoModeEndpoint(_chatRequest: unknown, knownEndpoints: IChatEndpoint[]): Promise<IChatEndpoint> {
		// Pick the first available endpoint (the default model) as the "auto" choice
		if (knownEndpoints.length > 0) {
			return knownEndpoints[0];
		}
		throw new Error('No chat endpoints available for auto-mode resolution');
	}
}

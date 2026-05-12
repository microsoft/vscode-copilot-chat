/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { IExperimentationService } from '../../../platform/telemetry/common/nullExperimentationService';

/**
 * Feature flag name for the memory kill switch.
 * When this flag is enabled, all memory operations (tools, prompt injection, retrieval)
 * are disabled in VS Code until core memory features reach full parity across clients.
 */
const MEMORY_DISABLED_VSCODE_FF = 'copilot_swe_agent_memory_disabled_vscode';

/**
 * Checks whether the memory kill switch feature flag is active.
 * When active, all memory operations should be disabled.
 */
export function isMemoryDisabledByKillSwitch(experimentationService: IExperimentationService): boolean {
	return experimentationService.getTreatmentVariable<boolean>(MEMORY_DISABLED_VSCODE_FF) === true;
}

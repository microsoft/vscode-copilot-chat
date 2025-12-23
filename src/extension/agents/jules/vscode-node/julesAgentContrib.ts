/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { IExtensionContribution } from '../../../common/contributions';
import { ILogService } from '../../../../platform/log/common/logService';
import { IInstantiationService } from '../../../../util/vs/platform/instantiation/common/instantiation';
import { Disposable } from '../../../../util/vs/base/common/lifecycle';
import { JulesAgent } from '../node/julesAgent';
import { BYOKStorageService } from '../../../byok/vscode-node/byokStorageService';
import { IVSCodeExtensionContext } from '../../../../platform/extContext/common/extensionContext';

export class JulesAgentContrib extends Disposable implements IExtensionContribution {
    public readonly id = 'jules-agent-contrib';

    constructor(
        @ILogService private readonly _logService: ILogService,
        @IInstantiationService private readonly _instantiationService: IInstantiationService,
        @IVSCodeExtensionContext private readonly _context: IVSCodeExtensionContext
    ) {
        super();
        const storageService = new BYOKStorageService(this._context);
        this._register(this._instantiationService.createInstance(JulesAgent, storageService));
    }
}

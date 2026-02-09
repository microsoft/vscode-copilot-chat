/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import '../../node/toolPermissionHandlers/index';

// Import all VS Code-specific handlers to trigger self-registration
// These handlers use VS Code APIs (vscode.window, etc.)
import './askUserQuestionHandler';

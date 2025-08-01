/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
import * as vscode from 'vscode';

// Here we add an artifical `__vscodeBrand` to types with names which appear both
// in the vscode API and in this project. This helps ensure that we depend
// on the correct types in the code which interacts with the vscode API.
declare module 'vscode' {
	export interface MarkdownString { __vscodeBrand: undefined }
	export interface Position { __vscodeBrand: undefined }
	export interface Range { __vscodeBrand: undefined }
	export interface Selection { __vscodeBrand: undefined }
	export interface TextEdit { __vscodeBrand: undefined }
}

export import Position = vscode.Position;
export import Range = vscode.Range;
export import Selection = vscode.Selection;
export import EventEmitter = vscode.EventEmitter;
export import CancellationTokenSource = vscode.CancellationTokenSource;
export import Diagnostic = vscode.Diagnostic;
export import TextEdit = vscode.TextEdit;
export import WorkspaceEdit = vscode.WorkspaceEdit;
export import Uri = vscode.Uri;
export import MarkdownString = vscode.MarkdownString;
export import TextEditorCursorStyle = vscode.TextEditorCursorStyle;
export import TextEditorLineNumbersStyle = vscode.TextEditorLineNumbersStyle;
export import TextEditorRevealType = vscode.TextEditorRevealType;
export import EndOfLine = vscode.EndOfLine;
export import DiagnosticSeverity = vscode.DiagnosticSeverity;
export import ExtensionMode = vscode.ExtensionMode;
export import Location = vscode.Location;
export import DiagnosticRelatedInformation = vscode.DiagnosticRelatedInformation;
export import ChatVariableLevel = vscode.ChatVariableLevel;
export import ChatResponseClearToPreviousToolInvocationReason = vscode.ChatResponseClearToPreviousToolInvocationReason;
export import ChatResponseMarkdownPart = vscode.ChatResponseMarkdownPart;
export import ChatResponseFileTreePart = vscode.ChatResponseFileTreePart;
export import ChatResponseAnchorPart = vscode.ChatResponseAnchorPart;
export import ChatResponseProgressPart = vscode.ChatResponseProgressPart;
export import ChatResponseProgressPart2 = vscode.ChatResponseProgressPart2;
export import ChatResponseReferencePart = vscode.ChatResponseReferencePart;
export import ChatResponseReferencePart2 = vscode.ChatResponseReferencePart2;
export import ChatResponseCodeCitationPart = vscode.ChatResponseCodeCitationPart;
export import ChatResponseCommandButtonPart = vscode.ChatResponseCommandButtonPart;
export import ChatResponseWarningPart = vscode.ChatResponseWarningPart;
export import ChatResponseMovePart = vscode.ChatResponseMovePart;
export import ChatResponseExtensionsPart = vscode.ChatResponseExtensionsPart;
export import ChatResponsePullRequestPart = vscode.ChatResponsePullRequestPart;
export import ChatResponseMarkdownWithVulnerabilitiesPart = vscode.ChatResponseMarkdownWithVulnerabilitiesPart;
export import ChatResponseCodeblockUriPart = vscode.ChatResponseCodeblockUriPart;
export import ChatResponseTextEditPart = vscode.ChatResponseTextEditPart;
export import ChatResponseNotebookEditPart = vscode.ChatResponseNotebookEditPart;
export import ChatResponseConfirmationPart = vscode.ChatResponseConfirmationPart;
export import ChatPrepareToolInvocationPart = vscode.ChatPrepareToolInvocationPart;
export import ChatRequest = vscode.ChatRequest;
export import ChatRequestTurn = vscode.ChatRequestTurn;
export import ChatResponseTurn = vscode.ChatResponseTurn;
export import NewSymbolName = vscode.NewSymbolName;
export import NewSymbolNameTag = vscode.NewSymbolNameTag;
export import NewSymbolNameTriggerKind = vscode.NewSymbolNameTriggerKind;
export import ChatLocation = vscode.ChatLocation;
export import ChatRequestEditorData = vscode.ChatRequestEditorData;
export import ChatRequestNotebookData = vscode.ChatRequestNotebookData;
export import LanguageModelToolInformation = vscode.LanguageModelToolInformation;
export import LanguageModelToolResult = vscode.LanguageModelToolResult;
export import ExtendedLanguageModelToolResult = vscode.ExtendedLanguageModelToolResult;
export import LanguageModelToolResult2 = vscode.LanguageModelToolResult2;
export import SymbolInformation = vscode.SymbolInformation;
export import LanguageModelPromptTsxPart = vscode.LanguageModelPromptTsxPart;
export import LanguageModelTextPart = vscode.LanguageModelTextPart;
export import LanguageModelTextPart2 = vscode.LanguageModelTextPart2;
export import LanguageModelDataPart = vscode.LanguageModelDataPart;
export import LanguageModelDataPart2 = vscode.LanguageModelDataPart2;
export import ToolResultAudience = vscode.ToolResultAudience;
export import LanguageModelToolMCPSource = vscode.LanguageModelToolMCPSource;
export import LanguageModelToolExtensionSource = vscode.LanguageModelToolExtensionSource;
export import ChatImageMimeType = vscode.ChatImageMimeType;
export import ChatReferenceBinaryData = vscode.ChatReferenceBinaryData;
export import ChatReferenceDiagnostic = vscode.ChatReferenceDiagnostic;
export import TextSearchMatch2 = vscode.TextSearchMatch2;
export import AISearchKeyword = vscode.AISearchKeyword;
export import ExcludeSettingOptions = vscode.ExcludeSettingOptions;
export import NotebookCellKind = vscode.NotebookCellKind;
export import NotebookRange = vscode.NotebookRange;
export import NotebookEdit = vscode.NotebookEdit;
export import NotebookCellData = vscode.NotebookCellData;
export import NotebookData = vscode.NotebookData;
export import ChatErrorLevel = vscode.ChatErrorLevel;
export import TerminalShellExecutionCommandLineConfidence = vscode.TerminalShellExecutionCommandLineConfidence;
export import ChatRequestEditedFileEventKind = vscode.ChatRequestEditedFileEventKind;
export import Extension = vscode.Extension;

export const l10n = {
	/**
	 * @deprecated Only use this import in tests. For the actual extension,
	 * use `import { l10n } from 'vscode'` or `import * as l10n from '@vscode/l10n'`.
	 */
	t: vscode.l10n.t
};

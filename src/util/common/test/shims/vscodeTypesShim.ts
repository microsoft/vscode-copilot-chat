/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscodeTypes from '../../../../vscodeTypes';
import { CancellationTokenSource } from '../../../vs/base/common/cancellation';
import { Emitter as EventEmitter } from '../../../vs/base/common/event';
import { URI as Uri } from '../../../vs/base/common/uri';
import { AISearchKeyword, ChatErrorLevel, ChatImageMimeType, ChatPrepareToolInvocationPart, ChatReferenceBinaryData, ChatReferenceDiagnostic, ChatRequestEditedFileEventKind, ChatRequestEditorData, ChatRequestNotebookData, ChatRequestTurn, ChatResponseAnchorPart, ChatResponseClearToPreviousToolInvocationReason, ChatResponseCodeblockUriPart, ChatResponseCodeCitationPart, ChatResponseCommandButtonPart, ChatResponseConfirmationPart, ChatResponseExtensionsPart, ChatResponseFileTreePart, ChatResponseMarkdownPart, ChatResponseMarkdownWithVulnerabilitiesPart, ChatResponseMovePart, ChatResponseNotebookEditPart, ChatResponseProgressPart, ChatResponseProgressPart2, ChatResponsePullRequestPart, ChatResponseReferencePart, ChatResponseReferencePart2, ChatResponseTextEditPart, ChatResponseTurn, ChatResponseWarningPart, ExcludeSettingOptions, LanguageModelDataPart, LanguageModelDataPart2, LanguageModelPromptTsxPart, LanguageModelTextPart, LanguageModelTextPart2, LanguageModelToolExtensionSource, LanguageModelToolMCPSource, LanguageModelToolResult, LanguageModelToolResult2, TextSearchMatch2, ToolResultAudience } from './chatTypes';
import { Diagnostic, DiagnosticRelatedInformation, Location } from './diagnostics';
import { TextEdit, WorkspaceEdit } from './editing';
import { ChatLocation, ChatVariableLevel, DiagnosticSeverity, EndOfLine, ExtensionMode, TextEditorCursorStyle, TextEditorLineNumbersStyle, TextEditorRevealType } from './enums';
import { t } from './l10n';
import { MarkdownString } from './markdownString';
import { NewSymbolName, NewSymbolNameTag, NewSymbolNameTriggerKind } from './newSymbolName';
import { NotebookCellData, NotebookCellKind, NotebookData, NotebookEdit, NotebookRange } from './notebookDocument';
import { Position } from './position';
import { Range } from './range';
import { Selection } from './selection';
import { SymbolInformation } from './symbolInformation';
import { TerminalShellExecutionCommandLineConfidence } from './terminal';

const shim: typeof vscodeTypes = {
	Position,
	Range,
	Selection,
	EventEmitter,
	CancellationTokenSource,
	Diagnostic,
	Location,
	DiagnosticRelatedInformation,
	TextEdit,
	WorkspaceEdit: <any>WorkspaceEdit,
	Uri,
	MarkdownString,
	DiagnosticSeverity,
	TextEditorCursorStyle,
	TextEditorLineNumbersStyle,
	TextEditorRevealType,
	EndOfLine,
	l10n: {
		t
	},
	ExtensionMode,
	ChatVariableLevel,
	ChatResponseClearToPreviousToolInvocationReason,
	ChatResponseMarkdownPart,
	ChatResponseFileTreePart,
	ChatResponseAnchorPart,
	ChatResponseMovePart,
	ChatResponseExtensionsPart,
	ChatResponseProgressPart,
	ChatResponseProgressPart2,
	ChatResponseWarningPart,
	ChatResponseReferencePart,
	ChatResponseReferencePart2,
	ChatResponseCodeCitationPart,
	ChatResponseCommandButtonPart,
	ChatResponseMarkdownWithVulnerabilitiesPart,
	ChatResponseCodeblockUriPart,
	ChatResponseTextEditPart,
	ChatResponseNotebookEditPart,
	ChatResponseConfirmationPart,
	ChatPrepareToolInvocationPart,
	ChatRequestTurn,
	ChatResponseTurn,
	ChatRequestEditorData,
	ChatRequestNotebookData,
	NewSymbolName,
	NewSymbolNameTag,
	NewSymbolNameTriggerKind,
	ChatLocation,
	SymbolInformation,
	LanguageModelToolResult,
	ExtendedLanguageModelToolResult: LanguageModelToolResult,
	LanguageModelToolResult2,
	LanguageModelPromptTsxPart,
	LanguageModelTextPart,
	LanguageModelDataPart,
	LanguageModelToolExtensionSource,
	LanguageModelToolMCPSource,
	ChatImageMimeType,
	ChatReferenceBinaryData,
	ChatReferenceDiagnostic,
	TextSearchMatch2,
	AISearchKeyword,
	ExcludeSettingOptions,
	NotebookCellKind,
	NotebookRange,
	NotebookEdit,
	NotebookCellData,
	NotebookData,
	ChatErrorLevel,
	TerminalShellExecutionCommandLineConfidence,
	ChatRequestEditedFileEventKind,
	ChatResponsePullRequestPart,
	LanguageModelTextPart2,
	LanguageModelDataPart2,
	ToolResultAudience
};

export = shim;

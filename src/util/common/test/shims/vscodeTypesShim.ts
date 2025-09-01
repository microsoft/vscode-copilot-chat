/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscodeTypes from '../../../../vscodeTypes';
import { CancellationTokenSource } from '../../../vs/base/common/cancellation';
import { Emitter as EventEmitter } from '../../../vs/base/common/event';
import { URI as Uri } from '../../../vs/base/common/uri';
import { Diagnostic, DiagnosticRelatedInformation } from '../../../vs/workbench/api/common/extHostTypes/diagnostic';
import { Location } from '../../../vs/workbench/api/common/extHostTypes/location';
import { MarkdownString } from '../../../vs/workbench/api/common/extHostTypes/markdownString';
import { NotebookCellData, NotebookCellKind, NotebookData, NotebookEdit, NotebookRange } from '../../../vs/workbench/api/common/extHostTypes/notebooks';
import { Position } from '../../../vs/workbench/api/common/extHostTypes/position';
import { Range } from '../../../vs/workbench/api/common/extHostTypes/range';
import { Selection } from '../../../vs/workbench/api/common/extHostTypes/selection';
import { SymbolInformation } from '../../../vs/workbench/api/common/extHostTypes/symbolInformation';
import { EndOfLine, TextEdit } from '../../../vs/workbench/api/common/extHostTypes/textEdit';
import { AISearchKeyword, ChatErrorLevel, ChatImageMimeType, ChatPrepareToolInvocationPart, ChatReferenceBinaryData, ChatReferenceDiagnostic, ChatRequestEditedFileEventKind, ChatRequestEditorData, ChatRequestNotebookData, ChatRequestTurn, ChatResponseAnchorPart, ChatResponseClearToPreviousToolInvocationReason, ChatResponseCodeblockUriPart, ChatResponseCodeCitationPart, ChatResponseCommandButtonPart, ChatResponseConfirmationPart, ChatResponseExtensionsPart, ChatResponseFileTreePart, ChatResponseMarkdownPart, ChatResponseMarkdownWithVulnerabilitiesPart, ChatResponseMovePart, ChatResponseNotebookEditPart, ChatResponseProgressPart, ChatResponseProgressPart2, ChatResponsePullRequestPart, ChatResponseReferencePart, ChatResponseReferencePart2, ChatResponseTextEditPart, ChatResponseThinkingProgressPart, ChatResponseTurn, ChatResponseWarningPart, ExcludeSettingOptions, LanguageModelChatMessageRole, LanguageModelDataPart, LanguageModelDataPart2, LanguageModelPartAudience, LanguageModelPromptTsxPart, LanguageModelTextPart, LanguageModelTextPart2, LanguageModelToolCallPart, LanguageModelToolExtensionSource, LanguageModelToolMCPSource, LanguageModelToolResult, LanguageModelToolResult2, LanguageModelToolResultPart, LanguageModelToolResultPart2, TextSearchMatch2, ChatToolInvocationPart, ChatResponseTurn2 } from './chatTypes';
import { TextDocumentChangeReason, TextEditorSelectionChangeKind, WorkspaceEdit } from './editing';
import { ChatLocation, ChatVariableLevel, DiagnosticSeverity, ExtensionMode, TextEditorCursorStyle, TextEditorLineNumbersStyle, TextEditorRevealType } from './enums';
import { t } from './l10n';
import { NewSymbolName, NewSymbolNameTag, NewSymbolNameTriggerKind } from './newSymbolName';
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
	SymbolInformation: SymbolInformation as any,
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
	LanguageModelPartAudience,
	ChatResponseThinkingProgressPart,
	LanguageModelToolCallPart,
	LanguageModelToolResultPart,
	LanguageModelToolResultPart2,
	LanguageModelChatMessageRole,
	TextEditorSelectionChangeKind,
	TextDocumentChangeReason,
	ChatToolInvocationPart,
	ChatResponseTurn2,
	ChatRequestTurn2: ChatRequestTurn
};

export = shim;

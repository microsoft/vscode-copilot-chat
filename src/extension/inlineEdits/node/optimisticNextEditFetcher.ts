/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type * as vscode from 'vscode';
import { CancellationTokenSource } from '../../../util/vs/base/common/cancellation';
import { Disposable } from '../../../util/vs/base/common/lifecycle';
import { ILogService } from '../../../platform/log/common/logService';
import { DocumentId } from '../../../platform/inlineEdits/common/dataTypes/documentId';
import { StringReplacement } from '../../../util/vs/editor/common/core/edits/stringEdit';
import { StringText } from '../../../util/vs/editor/common/core/text/abstractText';
import { NextEditCache } from './nextEditCache';
import { INextEditProvider, NextEditFetchRequest } from './nextEditProvider';
import { NextEditResult } from './nextEditResult';
import { generateUuid } from '../../../util/vs/base/common/uuid';

export interface OptimisticPrediction {
	docId: DocumentId;
	documentStateAfterEdit: StringText;
	prediction: Promise<NextEditResult | undefined>;
	resolvedValue?: NextEditResult; // Store the resolved value separately
	cancellationSource: CancellationTokenSource;
	timestamp: number;
}

export interface IOptimisticNextEditFetcher extends Disposable {
	triggerOptimisticFetch(
		docId: DocumentId,
		acceptedEdit: NextEditResult,
		currentDocumentContent: StringText
	): void;

	getOptimisticPrediction(docId: DocumentId): OptimisticPrediction | undefined;

	getOptimisticPredictionForDocument(docId: DocumentId, currentDocument: StringText): OptimisticPrediction | undefined;

	clearPredictions(docId: DocumentId): void;
}

export class OptimisticNextEditFetcher extends Disposable implements IOptimisticNextEditFetcher {
	private readonly _predictions = new Map<string, OptimisticPrediction[]>();
	private readonly _activeFetches = new Map<string, CancellationTokenSource>();

	constructor(
		private readonly _nextEditProvider: INextEditProvider<NextEditResult, any>,
		private readonly _nextEditCache: NextEditCache,
		private readonly _logService: ILogService,
		private readonly _maxPredictionDepth: number = 3
	) {
		super();
	}

	public triggerOptimisticFetch(
		docId: DocumentId,
		acceptedEdit: NextEditResult,
		currentDocumentContent: StringText
	): void {
		if (!acceptedEdit.result?.edit) {
			return;
		}

		const docKey = docId.toString();
		this._logService.logger.trace('[OptimisticFetch] Starting optimistic fetch chain for doc: ' + docKey);

		// Cancel any existing fetch for this document
		this._activeFetches.get(docKey)?.cancel();

		// Keep existing predictions - they might match future document states

		// Start the optimistic fetch chain
		this._startOptimisticChain(docId, currentDocumentContent, acceptedEdit.result.edit, 0);
	}

	private _startOptimisticChain(
		docId: DocumentId,
		documentContent: StringText,
		lastEdit: StringReplacement,
		depth: number
	): void {
		if (depth >= this._maxPredictionDepth) {
			this._logService.logger.trace(`[OptimisticFetch] Max depth reached (${depth}), stopping chain`);
			return;
		}

		const docKey = docId.toString();
		const cancellationSource = new CancellationTokenSource();

		// Apply the last edit to get the predicted document state
		const documentAfterEdit = this._applyEdit(documentContent, lastEdit);

		// Get the position after the edit (unused but kept for future use)
		// const position = (lastEdit as any).range?.endOffset || 0;

		// Create a synthetic context for the optimistic fetch
		const syntheticContext: vscode.InlineCompletionContext = {
			triggerKind: 0 as vscode.InlineCompletionTriggerKind,
			selectedCompletionInfo: undefined,
			requestUuid: generateUuid(),
		};

		// Create the prediction promise
		const predictionPromise = this._fetchOptimisticEdit(
			docId,
			documentAfterEdit,
			syntheticContext,
			cancellationSource.token
		);

		// Store the prediction
		const prediction: OptimisticPrediction = {
			docId,
			documentStateAfterEdit: documentAfterEdit,
			prediction: predictionPromise,
			cancellationSource,
			timestamp: Date.now(),
		};

		if (!this._predictions.has(docKey)) {
			this._predictions.set(docKey, []);
		}
		this._predictions.get(docKey)!.push(prediction);

		// When this prediction completes, update the stored prediction with the resolved value
		predictionPromise.then(result => {
			// Store the resolved value for instant access
			if (result && prediction) {
				prediction.resolvedValue = result;
				this._logService.logger.trace(`[OptimisticFetch] Stored resolved value at depth ${depth}`);
			}

			if (result?.result?.edit && !cancellationSource.token.isCancellationRequested) {
				// Recursively fetch the next prediction
				this._startOptimisticChain(
					docId,
					documentAfterEdit,
					result.result.edit,
					depth + 1
				);
			}
		}).catch(err => {
			this._logService.logger.trace(`[OptimisticFetch] Error at depth ${depth}: ${String(err)}`);
		});

		// Store the active fetch
		this._activeFetches.set(docKey, cancellationSource);
	}

	private async _fetchOptimisticEdit(
		_docId: DocumentId,
		_documentContent: StringText,
		_context: vscode.InlineCompletionContext,
		_cancellationToken: vscode.CancellationToken
	): Promise<NextEditResult | undefined> {
		try {
			// Call the NextEditProvider's optimistic fetch method
			const result = await (this._nextEditProvider as any).fetchOptimisticNextEdit(
				_docId,
				_documentContent,
				_context,
				_cancellationToken
			);
			return result;
		} catch (err) {
			this._logService.logger.trace('Optimistic fetch error: ' + String(err));
			return undefined;
		}
	}

	private _applyEdit(document: StringText, edit: StringReplacement): StringText {
		// Apply the edit to create the new document state
		const editOffset = (edit as any).range;
		if (!editOffset) {
			return document;
		}

		const before = document.value.substring(0, editOffset.startOffset);
		const after = document.value.substring(editOffset.endOffset);
		const newValue = before + edit.newText + after;

		// Create a proper StringText instance
		return new StringText(newValue);
	}

	public getOptimisticPrediction(docId: DocumentId): OptimisticPrediction | undefined {
		const docKey = docId.toString();
		const predictions = this._predictions.get(docKey);

		if (!predictions || predictions.length === 0) {
			return undefined;
		}

		const now = Date.now();
		// Return the first non-stale prediction that has a resolved value
		for (let i = 0; i < predictions.length; i++) {
			const prediction = predictions[i];
			// Consider predictions stale after 30 seconds
			if (now - prediction.timestamp < 30000) {
				// Only return predictions that have already resolved
				if (prediction.resolvedValue) {
					return prediction;
				}
			}
		}

		return undefined;
	}

	public getOptimisticPredictionForDocument(docId: DocumentId, currentDocument: StringText): OptimisticPrediction | undefined {
		const docKey = docId.toString();
		const predictions = this._predictions.get(docKey);

		if (!predictions || predictions.length === 0) {
			return undefined;
		}

		const now = Date.now();

		// Look for a prediction that matches the current document state
		for (let i = 0; i < predictions.length; i++) {
			const prediction = predictions[i];

			// Skip stale predictions (older than 30 seconds)
			if (now - prediction.timestamp >= 30000) {
				continue;
			}

			// Check if this prediction matches the current document state
			if (prediction.documentStateAfterEdit.value === currentDocument.value) {
				// Only return if it has already resolved
				if (prediction.resolvedValue) {
					this._logService.logger.trace(`[OptimisticFetch] Found matching prediction, age: ${now - prediction.timestamp}ms`);
					return prediction;
				}
			}
		}

		return undefined;
	}

	public clearPredictions(docId: DocumentId): void {
		const docKey = docId.toString();
		const predictions = this._predictions.get(docKey);

		if (predictions) {
			predictions.forEach(p => p.cancellationSource.cancel());
			this._predictions.delete(docKey);
		}

		this._activeFetches.get(docKey)?.cancel();
		this._activeFetches.delete(docKey);
	}

	public override dispose(): void {
		// Cancel all active fetches
		for (const [, cancellationSource] of this._activeFetches) {
			cancellationSource.cancel();
		}

		// Clear all predictions
		this._predictions.clear();
		this._activeFetches.clear();

		super.dispose();
	}
}
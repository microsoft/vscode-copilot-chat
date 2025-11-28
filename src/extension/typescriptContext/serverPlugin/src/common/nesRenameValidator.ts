/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
import type tt from 'typescript/lib/tsserverlibrary';
import TS from './typescript';
const ts = TS();

import type { PrepareNesRenameResponse } from './protocol';
import { Symbols } from './typescripts';

export class PrepareNesRenameResult {

	private canRename: boolean;
	private oldName: string | undefined;
	private reason: string | undefined;
	private timedOut: boolean;

	constructor() {
		this.canRename = false;
		this.oldName = undefined;
		this.reason = undefined;
		this.timedOut = false;
	}

	public setCanRename(value: false, reason?: string): PrepareNesRenameResult;
	public setCanRename(value: true, oldName: string): PrepareNesRenameResult;
	public setCanRename(value: boolean, str?: string): PrepareNesRenameResult {
		this.canRename = value;
		if (value) {
			this.oldName = str;
		} else {
			this.reason = str;
		}
		return this;
	}

	public setTimedOut(value: boolean): PrepareNesRenameResult {
		this.timedOut = value;
		return this;
	}

	public toJsonResponse(): PrepareNesRenameResponse.OK {
		if (this.timedOut) {
			return {
				canRename: false,
				reason: this.reason,
				timedOut: this.timedOut
			};
		} else {
			if (this.canRename) {
				return {
					canRename: true,
					oldName: this.oldName!,
				};
			} else {
				return {
					canRename: false,
					timedOut: false,
					reason: this.reason,
				};
			}
		}
	}
}

export function validateNesRename(result: PrepareNesRenameResult, program: tt.Program, node: tt.Node, oldName: string, newName: string, token: tt.CancellationToken): void {
	const symbols = new Symbols(program);
	const symbol = symbols.getLeafSymbolAtLocation(node);
	if (symbol === undefined) {
		result.setCanRename(false, 'No symbol found at location');
		return;
	}
	if (Symbols.isMethod(symbol)) {
		const parent = Symbols.getParent(symbol);
		if (parent !== undefined && (Symbols.isClass(parent) || Symbols.isInterface(parent))) {
			const members = parent.members;
			if (members !== undefined) {
				const newSymbol = members.get(ts.escapeLeadingUnderscores(newName));
				if (newSymbol === undefined) {
					result.setCanRename(true, oldName);
					return;
				}
			}
		}
	}
}
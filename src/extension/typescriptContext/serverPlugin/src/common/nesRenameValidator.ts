/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
import type tt from 'typescript/lib/tsserverlibrary';
import TS from './typescript';
const ts = TS();

import { PrepareNesRenameResponse, RenameKind } from './protocol';
import { Symbols } from './typescripts';

export class PrepareNesRenameResult {

	private canRename: RenameKind;
	private oldName: string | undefined;
	private reason: string | undefined;
	private timedOut: boolean;

	constructor() {
		this.canRename = RenameKind.no;
		this.oldName = undefined;
		this.reason = undefined;
		this.timedOut = false;
	}

	public getCanRename(): RenameKind {
		return this.canRename;
	}

	public setCanRename(value: RenameKind.no, reason?: string): PrepareNesRenameResult;
	public setCanRename(value: RenameKind.yes | RenameKind.maybe, oldName: string): PrepareNesRenameResult;
	public setCanRename(value: RenameKind, str?: string): PrepareNesRenameResult {
		this.canRename = value;
		if (value !== RenameKind.no) {
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
				canRename: RenameKind.no,
				reason: this.reason,
				timedOut: this.timedOut
			};
		} else {
			if (this.canRename === RenameKind.yes || this.canRename === RenameKind.maybe) {
				return {
					canRename: this.canRename,
					oldName: this.oldName!,
				};
			} else {
				return {
					canRename: RenameKind.no,
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
		result.setCanRename(RenameKind.no, 'No symbol found at location');
		return;
	}
	const escapedNewName = ts.escapeLeadingUnderscores(newName);
	// First see if the symbol has a parent. If so the new name must not conflict with existing members.
	const parent = Symbols.getParent(symbol);
	if (parent !== undefined) {
		const members = parent.members;
		if (members !== undefined && members.has(escapedNewName)) {
			result.setCanRename(RenameKind.no, `A member with the name '${newName}' already exists on '${parent.getName()}'`);
			return;
		}
		const exports = parent.exports;
		if (exports !== undefined && exports.has(escapedNewName)) {
			result.setCanRename(RenameKind.no, `An export with the name '${newName}' already exists on module '${parent.getName()}'`);
			return;
		}
		if (Symbols.isClass(parent) || Symbols.isInterface(parent)) {
			// check all super types.
			for (const superType of symbols.getAllSuperTypes(parent)) {
				const members = superType.members;
				if (members !== undefined && members.has(escapedNewName)) {
					result.setCanRename(RenameKind.no, `A member with the name '${newName}' already exists on base type '${superType.getName()}'`);
					return;
				}
				token.throwIfCancellationRequested();
			}
			result.setCanRename(RenameKind.yes, oldName);
			return;
		} else if (Symbols.isEnum(parent) || Symbols.isConstEnum(parent)) {
			result.setCanRename(RenameKind.yes, oldName);
			return;
		}
	}
	token.throwIfCancellationRequested();
	if (!isInScope(symbols, node, newName)) {
		result.setCanRename(RenameKind.yes, oldName);
		return;
	} else {
		result.setCanRename(RenameKind.no, `A symbol with the name '${newName}' already exists in the current scope`);
		return;
	}
}

function isInScope(symbols: Symbols, node: tt.Node, newName: string): boolean {
	const typeChecker = symbols.getTypeChecker();
	return typeChecker.resolveName(newName, node, ts.SymbolFlags.All, /* excludeGlobals */ false) !== undefined;
}
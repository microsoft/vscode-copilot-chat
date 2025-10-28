/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as npath from 'path';
import { createServiceIdentifier } from '../../../util/common/services';
import { isEqual } from '../../../util/vs/base/common/resources';
import { URI } from '../../../util/vs/base/common/uri';
import { Emitter, Event } from '../../../util/vs/base/common/event';
import { Disposable } from '../../../util/vs/base/common/lifecycle';
import { isWindows } from '../../../util/vs/base/common/platform';

export const ISystemContextService = createServiceIdentifier<ISystemContextService>('ISystemContextService');

export interface ISystemContextService {
	readonly _serviceBrand: undefined;
	readonly onDidChangeSystemContext: Event<void>;
	getSystemPaths(): readonly URI[];
	addSystemPaths(paths: readonly URI[]): void;
	replaceSystemPaths(paths: readonly URI[]): void;
	removeSystemPath(path: URI): void;
	clear(): void;
	isSystemPath(uri: URI): boolean;
}

export class SystemContextService extends Disposable implements ISystemContextService {
	declare readonly _serviceBrand: undefined;

	private readonly _onDidChangeSystemContext = this._register(new Emitter<void>());
	readonly onDidChangeSystemContext = this._onDidChangeSystemContext.event;

	private readonly _paths = new Map<string, URI>();

	getSystemPaths(): readonly URI[] {
		return Array.from(this._paths.values());
	}

	addSystemPaths(paths: readonly URI[]): void {
		let didChange = false;
		for (const path of paths) {
			const key = path.toString();
			if (!this._paths.has(key)) {
				this._paths.set(key, path);
				didChange = true;
			}
		}
		if (didChange) {
			this._onDidChangeSystemContext.fire();
		}
	}

	replaceSystemPaths(paths: readonly URI[]): void {
		this._paths.clear();
		for (const path of paths) {
			this._paths.set(path.toString(), path);
		}
		this._onDidChangeSystemContext.fire();
	}

	removeSystemPath(path: URI): void {
		for (const [key, storedPath] of this._paths) {
			if (isEqual(storedPath, path)) {
				this._paths.delete(key);
				this._onDidChangeSystemContext.fire();
				return;
			}
		}
	}

	clear(): void {
		if (this._paths.size === 0) {
			return;
		}
		this._paths.clear();
		this._onDidChangeSystemContext.fire();
	}

	isSystemPath(uri: URI): boolean {
		const candidateComparable = this.toComparablePath(uri);
		for (const stored of this._paths.values()) {
			const storedComparable = this.toComparablePath(stored);

			if (candidateComparable === storedComparable) {
				return true;
			}

			if (this.isSubPath(candidateComparable, storedComparable) || this.isSubPath(storedComparable, candidateComparable)) {
				return true;
			}
		}
		return false;
	}

	private toComparablePath(uri: URI): string {
		const normalized = npath.normalize(uri.fsPath);
		return isWindows ? normalized.toLowerCase() : normalized;
	}

	private isSubPath(child: string, potentialParent: string): boolean {
		if (potentialParent === child) {
			return true;
		}

		const parentWithSep = potentialParent.endsWith(npath.sep) ? potentialParent : potentialParent + npath.sep;
		return child.startsWith(parentWithSep);
	}
}

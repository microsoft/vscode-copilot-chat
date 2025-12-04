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

const MAX_EXTERNAL_PATHS = 3;

export const IExternalContextService = createServiceIdentifier<IExternalContextService>('IExternalContextService');

export interface IExternalContextService {
	readonly _serviceBrand: undefined;
	readonly onDidChangeExternalContext: Event<void>;
	readonly maxExternalPaths: number;
	getExternalPaths(): readonly URI[];
	addExternalPaths(paths: readonly URI[]): readonly URI[];
	replaceExternalPaths(paths: readonly URI[]): void;
	removeExternalPath(path: URI): void;
	clear(): void;
	isExternalPath(uri: URI): boolean;
}

export class ExternalContextService extends Disposable implements IExternalContextService {
	declare readonly _serviceBrand: undefined;

	private readonly _onDidChangeExternalContext = this._register(new Emitter<void>());
	readonly onDidChangeExternalContext: Event<void> = this._onDidChangeExternalContext.event;

	readonly maxExternalPaths = MAX_EXTERNAL_PATHS;

	private readonly _paths = new Map<string, URI>();

	getExternalPaths(): readonly URI[] {
		return [...this._paths.values()];
	}

	addExternalPaths(paths: readonly URI[]): readonly URI[] {
		const added: URI[] = [];
		if (!paths.length) {
			return added;
		}

		for (const path of paths) {
			if (this._paths.size >= MAX_EXTERNAL_PATHS) {
				break;
			}
			const key = path.toString();
			if (!this._paths.has(key)) {
				this._paths.set(key, path);
				added.push(path);
			}
		}
		if (added.length) {
			this._onDidChangeExternalContext.fire();
		}

		return added;
	}

	replaceExternalPaths(paths: readonly URI[]): void {
		this._paths.clear();
		for (const path of paths) {
			if (this._paths.size >= MAX_EXTERNAL_PATHS) {
				break;
			}
			const key = path.toString();
			if (!this._paths.has(key)) {
				this._paths.set(key, path);
			}
		}
		this._onDidChangeExternalContext.fire();
	}

	removeExternalPath(path: URI): void {
		for (const [key, storedPath] of this._paths) {
			if (isEqual(storedPath, path)) {
				this._paths.delete(key);
				this._onDidChangeExternalContext.fire();
				return;
			}
		}
	}

	clear(): void {
		if (this._paths.size === 0) {
			return;
		}
		this._paths.clear();
		this._onDidChangeExternalContext.fire();
	}

	isExternalPath(uri: URI): boolean {
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
		const parentWithSep = potentialParent.endsWith(npath.sep) ? potentialParent : potentialParent + npath.sep;
		return child.startsWith(parentWithSep);
	}
}

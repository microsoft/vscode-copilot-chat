/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Disposable, DisposableStore } from '../../../util/vs/base/common/lifecycle';
import { autorunWithStore, IObservable, ISettableObservable, observableFromEvent, observableValue, waitForState } from '../../../util/vs/base/common/observable';
import { IGitExtensionService } from '../../git/common/gitExtensionService';
import { API, Repository } from '../../git/vscode/git';

export class ObservableGit extends Disposable {

	private readonly _gitApi: IObservable<API | undefined>;

	public readonly branch: ISettableObservable<string | undefined, void>;

	constructor(
		@IGitExtensionService private readonly _gitExtensionService: IGitExtensionService,
	) {
		super();

		this._gitApi = observableFromEvent(this, (listener) => this._gitExtensionService.onDidChange(listener), () => this._gitExtensionService.getExtensionApi());

		this.branch = observableValue<string | undefined>('branchName', undefined);

		this.init();
	}

	async init() {
		try {
			const gitApi = await waitForState(this._gitApi);
			if (this._store.isDisposed) {
				return;
			}

			const repos = observableFromEvent(this, (e) => gitApi.onDidOpenRepository(e), () => {
				const r = gitApi.repositories;
				return Array.isArray(r) ? r : [];
			});

			await waitForState(repos, (repos) => repos.length > 0, undefined);
			if (this._store.isDisposed) {
				return;
			}

			// Track branches using autorunWithStore instead of mapObservableArrayCached
			// to avoid "items is not iterable" when the git API returns unexpected values
			const repoStores = new Map<string, DisposableStore>();
			this._store.add({ dispose: () => { for (const s of repoStores.values()) { s.dispose(); } repoStores.clear(); } });

			this._store.add(autorunWithStore((reader) => {
				const repoList = repos.read(reader);
				if (!Array.isArray(repoList)) {
					return;
				}

				const currentKeys = new Set<string>();
				for (const repo of repoList) {
					const key = repo.rootUri.toString();
					currentKeys.add(key);
					if (!repoStores.has(key)) {
						const store = new DisposableStore();
						repoStores.set(key, store);
						this._trackRepo(repo, store);
					}
				}

				// Clean up removed repos
				for (const [key, store] of repoStores) {
					if (!currentKeys.has(key)) {
						store.dispose();
						repoStores.delete(key);
					}
				}
			}));
		} catch {
			// Git extension may not be available or may return unexpected data
		}
	}

	private _trackRepo(repo: Repository, store: DisposableStore): void {
		const stateChangeObservable = observableFromEvent(listener => repo.state.onDidChange(listener), () => repo.state.HEAD?.name);
		store.add(autorunWithStore((reader) => {
			this.branch.set(stateChangeObservable.read(reader), undefined);
		}));
	}
}

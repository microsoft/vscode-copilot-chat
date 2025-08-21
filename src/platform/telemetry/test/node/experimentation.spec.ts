/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { beforeAll, describe, expect, it } from 'vitest';
import { IExperimentationService as ITASExperimentationService } from 'vscode-tas-client';
import { IInstantiationService } from '../../../../util/vs/platform/instantiation/common/instantiation';
import { CopilotToken } from '../../../authentication/common/copilotToken';
import { ICopilotTokenStore } from '../../../authentication/common/copilotTokenStore';
import { IVSCodeExtensionContext } from '../../../extContext/common/extensionContext';
import { createPlatformServices, ITestingServicesAccessor } from '../../../test/node/services';
import { IExperimentationService } from '../../common/nullExperimentationService';
import { BaseExperimentationService, TASClientDelegateFn, UserInfoStore } from '../../node/baseExperimentationService';


function toExpectedTreatment(configId: string, name: string, org: string | undefined, sku: string | undefined): string | undefined {
	return `${configId}.${name}.${org}.${sku}`;
}

class TestExperimentationService extends BaseExperimentationService {
	constructor(
		@IVSCodeExtensionContext extensionContext: IVSCodeExtensionContext,
		@ICopilotTokenStore tokenStore: ICopilotTokenStore
	) {

		const delegateFn: TASClientDelegateFn = (globalState: any, userInfoStore: UserInfoStore) => {
			return new class MockTASExperimentationService implements ITASExperimentationService {
				private _initializePromise: Promise<void> | undefined;
				private _initialFetch: Promise<void> | undefined;
				private _initialized = false;
				private _fetchedTreatments = false;

				constructor() {
				}

				get initializePromise(): Promise<void> {
					if (this._initializePromise) {
						return this._initializePromise;
					}

					// Resolve after 100ms
					this._initializePromise = new Promise<void>((resolve) => {
						setTimeout(() => {
							this._initialized = true;
							resolve();
						}, 100);
					});

					return this._initializePromise;
				}

				get initialFetch(): Promise<void> {
					if (this._initialFetch) {
						return this._initialFetch;
					}

					// Resolve after 100ms
					this._initialFetch = new Promise<void>((resolve) => {
						setTimeout(() => {
							this._fetchedTreatments = true;
							resolve();
						}, 100);
					});

					return this._initialFetch;
				}

				isFlightEnabled(flight: string): boolean {
					throw new Error('Method not implemented.');
				}
				isCachedFlightEnabled(flight: string): Promise<boolean> {
					throw new Error('Method not implemented.');
				}
				isFlightEnabledAsync(flight: string): Promise<boolean> {
					throw new Error('Method not implemented.');
				}
				getTreatmentVariable<T extends boolean | number | string>(configId: string, name: string): T | undefined {
					if (!this._initialized) {
						return undefined;
					}

					if (!this._fetchedTreatments) {
						return undefined;
					}

					const org = userInfoStore.internalOrg;
					const sku = userInfoStore.sku;
					return toExpectedTreatment(configId, name, org, sku) as T | undefined;
				}

				getTreatmentVariableAsync<T extends boolean | number | string>(configId: string, name: string, checkCache?: boolean): Promise<T | undefined> {
					return Promise.resolve(this.getTreatmentVariable(configId, name));
				}

				signIn(): void {

				}
			};
		};

		super(delegateFn, extensionContext, tokenStore);
	}
}

describe('ExP Service Tests', () => {
	let accessor: ITestingServicesAccessor;
	let expService: IExperimentationService;
	let copilotTokenService: ICopilotTokenStore;

	const GitHubProToken = new CopilotToken({ token: 'token-gh-pro', expires_at: 0, refresh_in: 0, username: 'fake', isVscodeTeamMember: false, chat_enabled: true, sku: 'pro', copilot_plan: 'unknown', organization_list: ['4535c7beffc844b46bb1ed4aa04d759a'] });
	const GitHubAndMicrosoftEnterpriseToken = new CopilotToken({ token: 'token-gh-msft-enterprise', expires_at: 0, refresh_in: 0, username: 'fake', isVscodeTeamMember: false, chat_enabled: true, sku: 'enterprise', copilot_plan: 'unknown', organization_list: ['4535c7beffc844b46bb1ed4aa04d759a', 'a5db0bcaae94032fe715fb34a5e4bce2'] });
	const MicrosoftEnterpriseToken = new CopilotToken({ token: 'token-msft-enterprise', expires_at: 0, refresh_in: 0, username: 'fake', isVscodeTeamMember: false, chat_enabled: true, sku: 'enterprise', copilot_plan: 'unknown', organization_list: ['a5db0bcaae94032fe715fb34a5e4bce2'] });
	const NoOrgFreeToken = new CopilotToken({ token: 'token-no-org-free', expires_at: 0, refresh_in: 0, username: 'fake', isVscodeTeamMember: false, chat_enabled: true, sku: 'free', copilot_plan: 'unknown' });

	beforeAll(() => {
		const testingServiceCollection = createPlatformServices();
		accessor = testingServiceCollection.createTestingAccessor();
		expService = accessor.get(IInstantiationService).createInstance(TestExperimentationService);
		copilotTokenService = accessor.get(ICopilotTokenStore);
	});

	const GetNewTreatmentsChangedPromise = () => {
		return new Promise<void>((resolve) => {
			expService.onDidTreatmentsChange(() => {
				resolve();
			});
		});
	};

	it('should return treatments based on copilot token', async () => {
		await expService.hasTreatments();
		let expectedTreatment = toExpectedTreatment('vscode', 'a', undefined, undefined);
		let treatment = expService.getTreatmentVariable<string>('vscode', 'a');
		expect(treatment).toBe(expectedTreatment);

		let treatmentsChangePromise = GetNewTreatmentsChangedPromise();

		// Sign in as GitHub with Pro SKU
		copilotTokenService.copilotToken = GitHubProToken;
		await treatmentsChangePromise;

		expectedTreatment = toExpectedTreatment('vscode', 'a', 'github', 'pro');
		treatment = expService.getTreatmentVariable<string>('vscode', 'a');
		expect(treatment).toBe(expectedTreatment);

		treatmentsChangePromise = GetNewTreatmentsChangedPromise();

		// Sign in as GitHub and Microsoft with Enterprise SKU
		copilotTokenService.copilotToken = GitHubAndMicrosoftEnterpriseToken;
		await treatmentsChangePromise;

		expectedTreatment = toExpectedTreatment('vscode', 'a', 'github', 'enterprise');
		treatment = expService.getTreatmentVariable<string>('vscode', 'a');
		expect(treatment).toBe(expectedTreatment);

		treatmentsChangePromise = GetNewTreatmentsChangedPromise();

		// Sign in as Microsoft with Enterprise SKU
		copilotTokenService.copilotToken = MicrosoftEnterpriseToken;
		await treatmentsChangePromise;

		expectedTreatment = toExpectedTreatment('vscode', 'a', 'microsoft', 'enterprise');
		treatment = expService.getTreatmentVariable<string>('vscode', 'a');
		expect(treatment).toBe(expectedTreatment);

		treatmentsChangePromise = GetNewTreatmentsChangedPromise();

		// Sign in as NoOrg with Free SKU
		copilotTokenService.copilotToken = NoOrgFreeToken;
		await treatmentsChangePromise;

		expectedTreatment = toExpectedTreatment('vscode', 'a', undefined, 'free');
		treatment = expService.getTreatmentVariable<string>('vscode', 'a');
		expect(treatment).toBe(expectedTreatment);

		treatmentsChangePromise = GetNewTreatmentsChangedPromise();

		// Sign out
		copilotTokenService.copilotToken = undefined;
		await treatmentsChangePromise;

		expectedTreatment = toExpectedTreatment('vscode', 'a', undefined, undefined);
		treatment = expService.getTreatmentVariable<string>('vscode', 'a');
		expect(treatment).toBe(expectedTreatment);

	});
});
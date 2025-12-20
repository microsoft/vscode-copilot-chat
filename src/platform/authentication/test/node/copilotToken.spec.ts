/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DeferredPromise } from '../../../../util/vs/base/common/async';
import { Event } from '../../../../util/vs/base/common/event';
import { DisposableStore } from '../../../../util/vs/base/common/lifecycle';
import { IInstantiationService } from '../../../../util/vs/platform/instantiation/common/instantiation';
import { ICAPIClientService } from '../../../endpoint/common/capiClient';
import { IDomainService } from '../../../endpoint/common/domainService';
import { IEnvService } from '../../../env/common/envService';
import { NullBaseOctoKitService } from '../../../github/common/nullOctokitServiceImpl';
import { ILogService } from '../../../log/common/logService';
import { FetchOptions, IAbortController, IFetcherService, PaginationOptions, Response } from '../../../networking/common/fetcherService';
import { ITelemetryService } from '../../../telemetry/common/telemetry';
import { createFakeResponse } from '../../../test/node/fetcher';
import { createPlatformServices, ITestingServicesAccessor } from '../../../test/node/services';
import { CopilotToken } from '../../common/copilotToken';
import { BaseCopilotTokenManager, CopilotTokenManagerFromGitHubToken } from '../../node/copilotTokenManager';

// This is a fake version of CopilotTokenManagerFromGitHubToken.
class RefreshFakeCopilotTokenManager extends BaseCopilotTokenManager {
	calls = 0;
	constructor(
		private readonly throwErrorCount: number,
		@ILogService logService: ILogService,
		@ITelemetryService telemetryService: ITelemetryService,
		@IDomainService domainService: IDomainService,
		@ICAPIClientService capiClientService: ICAPIClientService,
		@IFetcherService fetcherService: IFetcherService,
		@IEnvService envService: IEnvService,
	) {
		super(new NullBaseOctoKitService(capiClientService, fetcherService, logService, telemetryService), logService, telemetryService, domainService, capiClientService, fetcherService, envService);
	}

	async getCopilotToken(force?: boolean): Promise<CopilotToken> {
		this.calls++;
		await new Promise(resolve => setTimeout(resolve, 10));
		if (this.calls === this.throwErrorCount) {
			throw new Error('fake error');
		}
		if (!force && this.copilotToken) {
			return new CopilotToken(this.copilotToken);
		}
		this.copilotToken = { token: 'done', expires_at: 0, refresh_in: 0, username: 'fake', isVscodeTeamMember: false, copilot_plan: 'unknown' };
		return new CopilotToken(this.copilotToken);
	}
}

describe('Copilot token unit tests', function () {
	let accessor: ITestingServicesAccessor;
	let disposables: DisposableStore;

	beforeEach(() => {
		disposables = new DisposableStore();
		accessor = disposables.add(createPlatformServices().createTestingAccessor());
	});

	afterEach(() => {
		disposables.dispose();
	});

	it('includes editor information in token request', async function () {
		const fetcher = new StaticFetcherService({
			token: 'token',
			expires_at: 1,
			refresh_in: 1,
		});
		const testingServiceCollection = createPlatformServices();
		testingServiceCollection.define(IFetcherService, fetcher);
		accessor = disposables.add(testingServiceCollection.createTestingAccessor());

		const tokenManager = disposables.add(accessor.get(IInstantiationService).createInstance(RefreshFakeCopilotTokenManager, 1));
		await tokenManager.authFromGitHubToken('fake-token', 'fake-user');

		expect(fetcher.requests.size).toBe(2);
	});

	it(`notifies about token on token retrieval`, async function () {
		const tokenManager = disposables.add(accessor.get(IInstantiationService).createInstance(RefreshFakeCopilotTokenManager, 3));
		const deferredTokenPromise = new DeferredPromise<CopilotToken>();
		tokenManager.onDidCopilotTokenRefresh(async () => {
			const notifiedValue = await tokenManager.getCopilotToken();
			deferredTokenPromise.complete(notifiedValue);
		});
		await tokenManager.getCopilotToken(true);
		const notifiedValue = await deferredTokenPromise.p;
		expect(notifiedValue.token).toBe('done');
	});

	it('invalid GitHub token', async function () {
		const fetcher = new StaticFetcherService({
			error_details: {
				message: 'fake error message',
				url: 'https://github.com/settings?param={EDITOR}',
				notification_id: 'fake-notification-id',
			},
		});

		const testingServiceCollection = createPlatformServices();
		testingServiceCollection.define(IFetcherService, fetcher);
		accessor = disposables.add(testingServiceCollection.createTestingAccessor());

		const tokenManager = accessor.get(IInstantiationService).createInstance(CopilotTokenManagerFromGitHubToken, 'invalid', 'invalid-user');
		const result = await tokenManager.checkCopilotToken();
		expect(result).toEqual({
			kind: 'failure',
			reason: 'NotAuthorized',
			message: 'fake error message',
			notification_id: 'fake-notification-id',
			url: 'https://github.com/settings?param={EDITOR}',
		});
	});

	it('network request failed', async function () {
		const fetcher = new StaticFetcherService('NETWORK_FAILURE'); // special sentinel simulates network failure

		const testingServiceCollection = createPlatformServices();
		testingServiceCollection.define(IFetcherService, fetcher);
		accessor = disposables.add(testingServiceCollection.createTestingAccessor());

		const tokenManager = accessor.get(IInstantiationService).createInstance(CopilotTokenManagerFromGitHubToken, 'valid', 'valid-user');
		const result = await tokenManager.checkCopilotToken();
		expect(result).toEqual({
			kind: 'failure',
			reason: 'RequestFailed',
		});
	});

	it('JSON parse failed', async function () {
		const fetcher = new StaticFetcherService(null); // null tokenInfo simulates parse failure (JSON.parse returns null)

		const testingServiceCollection = createPlatformServices();
		testingServiceCollection.define(IFetcherService, fetcher);
		accessor = disposables.add(testingServiceCollection.createTestingAccessor());

		const tokenManager = accessor.get(IInstantiationService).createInstance(CopilotTokenManagerFromGitHubToken, 'valid', 'valid-user');
		const result = await tokenManager.checkCopilotToken();
		expect(result).toEqual({
			kind: 'failure',
			reason: 'ParseFailed',
		});
	});

	it('properly propagates errors', async function () {
		const expectedError = new Error('to be handled');

		const testingServiceCollection = createPlatformServices();
		testingServiceCollection.define(IFetcherService, new ErrorFetcherService(expectedError));
		accessor = disposables.add(testingServiceCollection.createTestingAccessor());

		const tokenManager = accessor.get(IInstantiationService).createInstance(CopilotTokenManagerFromGitHubToken, 'invalid', 'invalid-user');
		try {
			await tokenManager.checkCopilotToken();
		} catch (err: any) {
			expect(err).toBe(expectedError);
		}
	});

	it('ignore v1 token', async function () {
		const token =
			'0123456789abcdef0123456789abcdef:org1.com:1674258990:0000000000000000000000000000000000000000000000000000000000000000';

		const copilotToken = new CopilotToken({ token, expires_at: 0, refresh_in: 0, username: 'fake', isVscodeTeamMember: false, copilot_plan: 'unknown' });
		expect(copilotToken.getTokenValue('tid')).toBeUndefined();
	});

	it('parsing v2 token', async function () {
		const token =
			'tid=0123456789abcdef0123456789abcdef;dom=org1.com;ol=org1,org2;exp=1674258990:0000000000000000000000000000000000000000000000000000000000000000';

		const copilotToken = new CopilotToken({ token, expires_at: 0, refresh_in: 0, username: 'fake', isVscodeTeamMember: false, copilot_plan: 'unknown' });
		expect(copilotToken.getTokenValue('tid')).toBe('0123456789abcdef0123456789abcdef');
	});

	it('parsing v2 token, multiple values', async function () {
		const token =
			'tid=0123456789abcdef0123456789abcdef;rt=1;ssc=0;dom=org1.com;ol=org1,org2;exp=1674258990:0000000000000000000000000000000000000000000000000000000000000000';

		const copilotToken = new CopilotToken({ token, expires_at: 0, refresh_in: 0, username: 'fake', isVscodeTeamMember: false, copilot_plan: 'unknown' });
		expect(copilotToken.getTokenValue('rt')).toBe('1');
		expect(copilotToken.getTokenValue('ssc')).toBe('0');
		expect(copilotToken.getTokenValue('foo')).toBeUndefined();
	});

	it('With a GitHub Enterprise configuration, retrieves token from the GHEC server', async () => {
		const ghecConfig: IDomainService = {
			_serviceBrand: undefined,
			onDidChangeDomains: Event.None,
		};
		const fetcher = new StaticFetcherService({
			token: 'token',
			expires_at: 1,
			refresh_in: 1,
		});

		const testingServiceCollection = createPlatformServices();
		testingServiceCollection.define(IDomainService, ghecConfig);
		testingServiceCollection.define(IFetcherService, fetcher);
		accessor = disposables.add(testingServiceCollection.createTestingAccessor());

		const tokenManager = disposables.add(accessor.get(IInstantiationService).createInstance(RefreshFakeCopilotTokenManager, 1));
		await tokenManager.authFromGitHubToken('fake-token', 'invalid-user');

		expect(fetcher.requests.size).toBe(2);
	});
});

class StaticFetcherService implements IFetcherService {

	declare readonly _serviceBrand: undefined;

	public requests = new Map<string, FetchOptions>();
	constructor(readonly tokenResponse: any) {
	}

	fetchWithPagination<T>(baseUrl: string, options: PaginationOptions<T>): Promise<T[]> {
		throw new Error('Method not implemented.');
	}

	getUserAgentLibrary(): string {
		return 'test';
	}
	fetch(url: string, options: FetchOptions): Promise<Response> {
		this.requests.set(url, options);
		if (url.endsWith('copilot_internal/v2/token')) {
			if (this.tokenResponse === 'NETWORK_FAILURE') {
				// Simulate network failure - return null response
				return Promise.resolve(null as any);
			}
			// null will parse successfully as JSON (returns null) but fails tokenInfo check
			return Promise.resolve(createFakeResponse(200, this.tokenResponse));
		} else if (url.endsWith('copilot_internal/notification')) {
			return Promise.resolve(createFakeResponse(200, ''));
		}
		return Promise.resolve(createFakeResponse(404, ''));
	}
	disconnectAll(): Promise<unknown> {
		throw new Error('Method not implemented.');
	}
	makeAbortController(): IAbortController {
		throw new Error('Method not implemented.');
	}
	isAbortError(e: any): boolean {
		throw new Error('Method not implemented.');
	}
	isInternetDisconnectedError(e: any): boolean {
		throw new Error('Method not implemented.');
	}
	isFetcherError(err: any): boolean {
		throw new Error('Method not implemented.');
	}
	getUserMessageForFetcherError(err: any): string {
		throw new Error('Method not implemented.');
	}
}

class ErrorFetcherService extends StaticFetcherService {
	constructor(private readonly error: any) {
		super({});
	}

	override fetch(url: string, options: FetchOptions): Promise<Response> {
		throw this.error;
	}
}

/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
import type { Context } from '../context';
import { getLastKnownEndpoints } from '../networkConfiguration';
import { Fetcher } from '../networking';
import { codeReferenceLogger } from './logger';

type ConnectionAPI = {
	listen: (cb: () => void) => { dispose: () => void };
	setConnected: () => void;
	setRetrying: () => void;
	setDisconnected: () => void;
	setDisabled: () => void;
	enableRetry: (ctx: Context, initialTimeout?: number) => void;
	isConnected: () => boolean;
	isDisconnected: () => boolean;
	isRetrying: () => boolean;
	isDisabled: () => boolean;
	isInitialWait: () => boolean;
};

type ConnectionState = {
	connection: 'connected' | 'disconnected' | 'retry' | 'disabled';
	maxAttempts: number;
	retryAttempts: number;
	initialWait: boolean;
};

const InitialTimeout = 3000;
const BaseRetryTime = 2;
const MaxRetryTime = 256;
const MaxAttempts = Math.log(MaxRetryTime) / Math.log(BaseRetryTime) / BaseRetryTime;

const state: ConnectionState = {
	connection: 'disabled',
	maxAttempts: MaxAttempts,
	retryAttempts: 0,
	initialWait: false,
};

let stateAPI: ConnectionAPI;
const handlers: Array<() => void> = [];

function registerConnectionState(): ConnectionAPI {
	if (stateAPI) {
		return stateAPI;
	}

	function subscribe(cb: () => void) {
		handlers.push(cb);
		return () => {
			const index = handlers.indexOf(cb);
			if (index !== -1) {
				handlers.splice(index, 1);
			}
		};
	}

	function afterUpdateConnection() {
		for (const handler of handlers) {
			handler();
		}
	}

	function updateConnection(status: ConnectionState['connection']) {
		if (state.connection === status) {
			return;
		}

		state.connection = status;
		afterUpdateConnection();
	}

	function isConnected() {
		return state.connection === 'connected';
	}

	function isDisconnected() {
		return state.connection === 'disconnected';
	}

	function isRetrying() {
		return state.connection === 'retry';
	}

	function isDisabled() {
		return state.connection === 'disabled';
	}

	function setConnected() {
		updateConnection('connected');
		setInitialWait(false);
	}

	function setDisconnected() {
		updateConnection('disconnected');
	}

	function setRetrying() {
		updateConnection('retry');
	}

	function setDisabled() {
		updateConnection('disabled');
	}

	function setInitialWait(enabled: boolean) {
		if (state.initialWait !== enabled) {
			state.initialWait = enabled;
		}
	}

	function enableRetry(ctx: Context, initialTimeout = InitialTimeout) {
		if (isRetrying()) {
			return;
		}

		setRetrying();
		setInitialWait(true);
		void attemptToPing(ctx, initialTimeout);
	}

	function isInitialWait() {
		return state.initialWait;
	}

	async function attemptToPing(ctx: Context, initialTimeout: number) {
		codeReferenceLogger.info(ctx, `Attempting to reconnect in ${initialTimeout}ms.`);

		// Initial 3 second delay before attempting to reconnect to Snippy.
		await timeout(initialTimeout);
		setInitialWait(false);

		const fetcher = ctx.get(Fetcher);

		function succeedOrRetry(time: number, ctx: Context) {
			if (time > MaxRetryTime) {
				codeReferenceLogger.info(ctx, 'Max retry time reached, disabling.');
				setDisabled();
				return;
			}

			const tryAgain = async () => {
				state.retryAttempts = Math.min(state.retryAttempts + 1, MaxAttempts);

				try {
					codeReferenceLogger.info(ctx, `Pinging service after ${time} second(s)`);
					const response = await fetcher.fetch(
						new URL('_ping', getLastKnownEndpoints(ctx)['origin-tracker']).href,
						{
							method: 'GET',
							headers: {
								'content-type': 'application/json',
							},
						}
					);

					if (response.status !== 200 || !response.ok) {
						succeedOrRetry(time ** 2, ctx);
					} else {
						codeReferenceLogger.info(ctx, 'Successfully reconnected.');
						setConnected();
						return;
					}
				} catch (e) {
					succeedOrRetry(time ** 2, ctx);
				}
			};
			setTimeout(() => void tryAgain(), time * 1000);
		}

		codeReferenceLogger.info(ctx, 'Attempting to reconnect.');

		succeedOrRetry(BaseRetryTime, ctx);
	}

	const timeout = (ms: number) => {
		return new Promise(resolve => setTimeout(resolve, ms));
	};

	function listen(cb: () => void) {
		const disposer = subscribe(cb);
		return { dispose: disposer };
	}

	stateAPI = {
		setConnected,
		setDisconnected,
		setRetrying,
		setDisabled,
		enableRetry,
		listen,
		isConnected,
		isDisconnected,
		isRetrying,
		isDisabled,
		isInitialWait,
	};

	return stateAPI;
}

export const ConnectionState = registerConnectionState();

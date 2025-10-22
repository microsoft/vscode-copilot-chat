/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Context } from '../context';

type RuntimeFlag = 'debug' | 'verboseLogging' | 'testMode' | 'simulation';

export class RuntimeMode {
	constructor(readonly flags: Record<RuntimeFlag, boolean>) { }

	static fromEnvironment(isRunningInTest: boolean, argv = process.argv, env = process.env): RuntimeMode {
		return new RuntimeMode({
			debug: determineDebugFlag(argv, env),
			verboseLogging: determineVerboseLoggingEnabled(argv, env),
			testMode: isRunningInTest,
			simulation: determineSimulationFlag(env),
		});
	}
}

export function isRunningInTest(ctx: Context): boolean {
	return ctx.get(RuntimeMode).flags.testMode;
}

export function shouldFailForDebugPurposes(ctx: Context): boolean {
	return isRunningInTest(ctx);
}

export function isDebugEnabled(ctx: Context): boolean {
	return ctx.get(RuntimeMode).flags.debug;
}

function determineDebugFlag(argv: string[], env: NodeJS.ProcessEnv): boolean {
	return argv.includes('--debug') || determineEnvFlagEnabled(env, 'DEBUG');
}

function determineSimulationFlag(env: NodeJS.ProcessEnv): boolean {
	return determineEnvFlagEnabled(env, 'SIMULATION');
}

export function isRunningInSimulation(ctx: Context): boolean {
	return ctx.get(RuntimeMode).flags.simulation;
}

function determineVerboseLoggingEnabled(argv: string[], env: NodeJS.ProcessEnv): boolean {
	return (
		env['COPILOT_AGENT_VERBOSE'] === '1' ||
		env['COPILOT_AGENT_VERBOSE']?.toLowerCase() === 'true' ||
		determineEnvFlagEnabled(env, 'VERBOSE') ||
		determineDebugFlag(argv, env)
	);
}

function determineEnvFlagEnabled(env: NodeJS.ProcessEnv, name: string): boolean {
	for (const prefix of ['GH_COPILOT_', 'GITHUB_COPILOT_']) {
		const val = env[`${prefix}${name}`];
		if (val) {
			return val === '1' || val?.toLowerCase() === 'true';
		}
	}
	return false;
}

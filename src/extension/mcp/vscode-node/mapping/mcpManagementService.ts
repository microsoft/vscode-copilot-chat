/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { IGalleryMcpServerConfiguration, IMcpServerArgument, IMcpServerInput, IMcpServerKeyValueInput, McpServerConfigurationParseResult, RegistryType } from './mcpManagement';
import { IMcpServerVariable, McpServerType, McpServerVariableType } from './mcpPlatformTypes';

export class McpMappingUtility {
	getMcpServerConfigurationFromManifest(manifest: IGalleryMcpServerConfiguration, packageType: RegistryType): McpServerConfigurationParseResult {

		// remote
		if (packageType === RegistryType.REMOTE && manifest.remotes?.length) {
			const { inputs, variables } = this.processKeyValueInputs(manifest.remotes[0].headers ?? []);
			return {
				mcpServerConfiguration: {
					config: {
						type: McpServerType.REMOTE,
						url: manifest.remotes[0].url,
						headers: Object.keys(inputs).length ? inputs : undefined,
					},
					inputs: variables.length ? variables : undefined,
				},
				notices: [],
			};
		}

		// local
		const serverPackage = manifest.packages?.find(p => p.registryType === packageType) ?? manifest.packages?.[0];
		if (!serverPackage) {
			throw new Error(`No server package found`);
		}

		const args: string[] = [];
		const inputs: IMcpServerVariable[] = [];
		const env: Record<string, string> = {};
		const notices: string[] = [];

		if (serverPackage.registryType === RegistryType.DOCKER) {
			args.push('run');
			args.push('-i');
			args.push('--rm');
		}

		if (serverPackage.runtimeArguments?.length) {
			const result = this.processArguments(serverPackage.runtimeArguments ?? []);
			args.push(...result.args);
			inputs.push(...result.variables);
			notices.push(...result.notices);
		}

		if (serverPackage.environmentVariables?.length) {
			const { inputs: envInputs, variables: envVariables, notices: envNotices } = this.processKeyValueInputs(serverPackage.environmentVariables ?? []);
			inputs.push(...envVariables);
			notices.push(...envNotices);
			for (const [name, value] of Object.entries(envInputs)) {
				env[name] = value;
				if (serverPackage.registryType === RegistryType.DOCKER) {
					args.push('-e');
					args.push(name);
				}
			}
		}

		switch (serverPackage.registryType) {
			case RegistryType.NODE:
				args.push(serverPackage.version ? `${serverPackage.identifier}@${serverPackage.version}` : serverPackage.identifier);
				break;
			case RegistryType.PYTHON:
				args.push(serverPackage.version ? `${serverPackage.identifier}==${serverPackage.version}` : serverPackage.identifier);
				break;
			case RegistryType.DOCKER:
				args.push(serverPackage.version ? `${serverPackage.identifier}:${serverPackage.version}` : serverPackage.identifier);
				break;
			case RegistryType.NUGET:
				args.push(serverPackage.version ? `${serverPackage.identifier}@${serverPackage.version}` : serverPackage.identifier);
				args.push('--yes'); // installation is confirmed by the UI, so --yes is appropriate here
				if (serverPackage.packageArguments?.length) {
					args.push('--');
				}
				break;
		}

		if (serverPackage.packageArguments?.length) {
			const result = this.processArguments(serverPackage.packageArguments);
			args.push(...result.args);
			inputs.push(...result.variables);
			notices.push(...result.notices);
		}

		return {
			notices,
			mcpServerConfiguration: {
				config: {
					type: McpServerType.LOCAL,
					command: this.getCommandName(serverPackage.registryType),
					args: args.length ? args : undefined,
					env: Object.keys(env).length ? env : undefined,
				},
				inputs: inputs.length ? inputs : undefined,
			}
		};
	}

	protected getCommandName(packageType: RegistryType): string {
		switch (packageType) {
			case RegistryType.NODE: return 'npx';
			case RegistryType.DOCKER: return 'docker';
			case RegistryType.PYTHON: return 'uvx';
			case RegistryType.NUGET: return 'dnx';
		}
		return packageType;
	}

	protected getVariables(variableInputs: Record<string, IMcpServerInput>): IMcpServerVariable[] {
		const variables: IMcpServerVariable[] = [];
		for (const [key, value] of Object.entries(variableInputs)) {
			variables.push({
				id: key,
				type: value.choices ? McpServerVariableType.PICK : McpServerVariableType.PROMPT,
				description: value.description ?? '',
				password: !!value.isSecret,
				default: value.default,
				options: value.choices,
			});
		}
		return variables;
	}

	private processKeyValueInputs(keyValueInputs: ReadonlyArray<IMcpServerKeyValueInput>): { inputs: Record<string, string>; variables: IMcpServerVariable[]; notices: string[] } {
		const notices: string[] = [];
		const inputs: Record<string, string> = {};
		const variables: IMcpServerVariable[] = [];

		for (const input of keyValueInputs) {
			const inputVariables = input.variables ? this.getVariables(input.variables) : [];
			let value = input.value || '';

			// If explicit variables exist, use them regardless of value
			if (inputVariables.length) {
				for (const variable of inputVariables) {
					value = value.replace(`{${variable.id}}`, `\${input:${variable.id}}`);
				}
				variables.push(...inputVariables);
			} else if (!value && (input.description || input.choices || input.default !== undefined)) {
				// Only create auto-generated input variable if no explicit variables and no value
				variables.push({
					id: input.name,
					type: input.choices ? McpServerVariableType.PICK : McpServerVariableType.PROMPT,
					description: input.description ?? '',
					password: !!input.isSecret,
					default: input.default,
					options: input.choices,
				});
				value = `\${input:${input.name}}`;
			}

			inputs[input.name] = value;
		}

		return { inputs, variables, notices };
	}

	private processArguments(argumentsList: readonly IMcpServerArgument[]): { args: string[]; variables: IMcpServerVariable[]; notices: string[] } {
		const args: string[] = [];
		const variables: IMcpServerVariable[] = [];
		const notices: string[] = [];
		for (const arg of argumentsList) {
			const argVariables = arg.variables ? this.getVariables(arg.variables) : [];

			if (arg.type === 'positional') {
				let value = arg.value;
				if (value) {
					for (const variable of argVariables) {
						value = value.replace(`{${variable.id}}`, `\${input:${variable.id}}`);
					}
					args.push(value);
					if (argVariables.length) {
						variables.push(...argVariables);
					}
				} else if (arg.valueHint && (arg.description || arg.default !== undefined)) {
					// Create input variable for positional argument without value
					variables.push({
						id: arg.valueHint,
						type: McpServerVariableType.PROMPT,
						description: arg.description ?? '',
						password: false,
						default: arg.default,
					});
					args.push(`\${input:${arg.valueHint}}`);
				} else {
					// Fallback to value_hint as literal
					args.push(arg.valueHint ?? '');
				}
			} else if (arg.type === 'named') {
				if (!arg.name) {
					notices.push(`Named argument is missing a name. ${JSON.stringify(arg)}`);
					continue;
				}
				args.push(arg.name);
				if (arg.value) {
					let value = arg.value;
					for (const variable of argVariables) {
						value = value.replace(`{${variable.id}}`, `\${input:${variable.id}}`);
					}
					args.push(value);
					if (argVariables.length) {
						variables.push(...argVariables);
					}
				} else if (arg.description || arg.default !== undefined) {
					// Create input variable for named argument without value
					const variableId = arg.name.replace(/^--?/, '');
					variables.push({
						id: variableId,
						type: McpServerVariableType.PROMPT,
						description: arg.description ?? '',
						password: false,
						default: arg.default,
					});
					args.push(`\${input:${variableId}}`);
				}
			}
		}
		return { args, variables, notices };
	}
}
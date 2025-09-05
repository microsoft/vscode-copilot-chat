/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { PromptingStrategy } from '../../../../platform/inlineEdits/common/dataTypes/xtabPromptOptions';
import { Codexv21NesUnifiedPromptStrategy } from './codexv21NesUnifiedPromptStrategy';
import { DefaultPromptStrategy } from './defaultPromptStrategy';
import { Nes41Miniv3PromptStrategy } from './nes41Miniv3PromptStrategy';
import { PromptStrategyBase, PromptStrategyProps } from './promptStrategyBase';
import { SimplifiedPromptStrategy } from './simplifiedPromptStrategy';
import { UnifiedModelPromptStrategy } from './unifiedModelPromptStrategy';
import { Xtab275PromptStrategy } from './xtab275PromptStrategy';

/**
 * Type for prompt strategy constructor
 */
type PromptStrategyConstructor = new (props: PromptStrategyProps) => PromptStrategyBase;

/**
 * Registry for prompt strategies
 */
class PromptStrategyRegistry {
	private strategies = new Map<PromptingStrategy | 'default', PromptStrategyConstructor>();

	constructor() {
		this.registerDefaultStrategies();
	}

	/**
	 * Register the default strategies
	 */
	private registerDefaultStrategies(): void {
		this.strategies.set(PromptingStrategy.UnifiedModel, UnifiedModelPromptStrategy);
		this.strategies.set(PromptingStrategy.Codexv21NesUnified, Codexv21NesUnifiedPromptStrategy);
		this.strategies.set(PromptingStrategy.SimplifiedSystemPrompt, SimplifiedPromptStrategy);
		this.strategies.set(PromptingStrategy.Xtab275, Xtab275PromptStrategy);
		this.strategies.set(PromptingStrategy.Nes41Miniv3, Nes41Miniv3PromptStrategy);
		this.strategies.set('default', DefaultPromptStrategy);
	}

	/**
	 * Register a new prompt strategy
	 */
	register(strategy: PromptingStrategy, constructor: PromptStrategyConstructor): void {
		this.strategies.set(strategy, constructor);
	}

	/**
	 * Get a prompt strategy instance
	 */
	get(strategy: PromptingStrategy | undefined, props: PromptStrategyProps): PromptStrategyBase {
		const key = strategy ?? 'default';
		const Constructor = this.strategies.get(key);
		
		if (!Constructor) {
			throw new Error(`Unknown prompting strategy: ${strategy}`);
		}

		return new Constructor(props);
	}

	/**
	 * Check if a strategy is registered
	 */
	has(strategy: PromptingStrategy | undefined): boolean {
		const key = strategy ?? 'default';
		return this.strategies.has(key);
	}

	/**
	 * Get all registered strategy keys
	 */
	getRegisteredStrategies(): (PromptingStrategy | 'default')[] {
		return Array.from(this.strategies.keys());
	}
}

/**
 * Global instance of the prompt strategy registry
 */
export const promptStrategyRegistry = new PromptStrategyRegistry();

/**
 * Factory function to create prompt strategies
 */
export function createPromptStrategy(
	strategy: PromptingStrategy | undefined,
	props: PromptStrategyProps
): PromptStrategyBase {
	return promptStrategyRegistry.get(strategy, props);
}

/**
 * Register a new prompt strategy
 */
export function registerPromptStrategy(
	strategy: PromptingStrategy,
	constructor: PromptStrategyConstructor
): void {
	promptStrategyRegistry.register(strategy, constructor);
}
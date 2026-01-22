/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Emitter } from '../../../util/vs/base/common/event';
import { Disposable } from '../../../util/vs/base/common/lifecycle';
import type {
	IAgentInfo,
	IAgentStepContext,
	IAgentTrajectory,
	IObservationResult,
	IStepMetrics,
	ISubagentTrajectoryRef,
	IToolCall,
	ITrajectoryLogger,
	ITrajectoryStep
} from '../common/trajectoryLogger';
import { TRAJECTORY_SCHEMA_VERSION } from '../common/trajectoryTypes';

/**
 * Concrete implementation of the trajectory logger
 */
export class TrajectoryLogger extends Disposable implements ITrajectoryLogger {
	declare readonly _serviceBrand: undefined;

	private readonly trajectories = new Map<string, TrajectoryBuilder>();
	private currentSessionId: string | undefined;
	private subagentTrajectories = new Map<string, IAgentTrajectory>();

	private readonly _onDidUpdateTrajectory = this._register(new Emitter<void>());
	public readonly onDidUpdateTrajectory = this._onDidUpdateTrajectory.event;

	public startTrajectory(sessionId: string, agentInfo: IAgentInfo): void {
		let builder = this.trajectories.get(sessionId);
		if (!builder) {
			builder = new TrajectoryBuilder(sessionId, agentInfo);
			this.trajectories.set(sessionId, builder);
		}
		this.currentSessionId = sessionId;
		this._onDidUpdateTrajectory.fire();
	}

	private getCurrentTrajectoryBuilder(): TrajectoryBuilder | undefined {
		if (!this.currentSessionId) {
			return undefined;
		}
		return this.trajectories.get(this.currentSessionId);
	}

	public addSystemStep(message: string, timestamp?: string): void {
		const current = this.getCurrentTrajectoryBuilder();
		if (!current) {
			return;
		}
		current.addSystemStep(message, timestamp);
		this._onDidUpdateTrajectory.fire();
	}

	public addUserStep(message: string, timestamp?: string): void {
		const current = this.getCurrentTrajectoryBuilder();
		if (!current) {
			return;
		}
		current.addUserStep(message, timestamp);
		this._onDidUpdateTrajectory.fire();
	}

	public beginAgentStep(
		message: string,
		modelName?: string,
		reasoningContent?: string,
		timestamp?: string
	): IAgentStepContext {
		const current = this.getCurrentTrajectoryBuilder();
		if (!current) {
			throw new Error('No active trajectory. Call startTrajectory first.');
		}
		const context = current.beginAgentStep(message, modelName, reasoningContent, timestamp);
		return {
			addToolCalls: (toolCalls) => context.addToolCalls(toolCalls),
			addObservation: (results) => context.addObservation(results),
			addSubagentReference: (toolCallId, subagentRef) => context.addSubagentReference(toolCallId, subagentRef),
			setMetrics: (metrics) => context.setMetrics(metrics),
			complete: () => {
				context.complete();
				this._onDidUpdateTrajectory.fire();
			}
		};
	}

	public getTrajectory(): IAgentTrajectory | undefined {
		return this.getCurrentTrajectoryBuilder()?.build();
	}

	public getAllTrajectories(): Map<string, IAgentTrajectory> {
		const trajectories = new Map<string, IAgentTrajectory>();
		for (const builder of this.trajectories.values()) {
			const trajectory = builder.build();
			trajectories.set(trajectory.session_id, trajectory);
		}
		for (const [sessionId, trajectory] of this.subagentTrajectories) {
			trajectories.set(sessionId, trajectory);
		}
		return trajectories;
	}

	public clearTrajectory(): void {
		this.trajectories.clear();
		this.currentSessionId = undefined;
		this.subagentTrajectories.clear();
		this._onDidUpdateTrajectory.fire();
	}

	public hasActiveTrajectory(): boolean {
		return this.currentSessionId !== undefined;
	}

	public getCurrentSessionId(): string | undefined {
		return this.currentSessionId;
	}

	/**
	 * Register a subagent trajectory
	 * @internal Used by subagent implementations
	 */
	public registerSubagentTrajectory(trajectory: IAgentTrajectory): void {
		this.subagentTrajectories.set(trajectory.session_id, trajectory);
		this._onDidUpdateTrajectory.fire();
	}
}

/**
 * Builder for constructing a trajectory incrementally
 */
class TrajectoryBuilder {
	private steps: ITrajectoryStep[] = [];
	private stepCounter = 0;

	constructor(
		private readonly sessionId: string,
		private readonly agentInfo: IAgentInfo
	) { }

	public getSessionId(): string {
		return this.sessionId;
	}

	public addSystemStep(message: string, timestamp?: string): void {
		this.steps.push({
			step_id: ++this.stepCounter,
			timestamp: timestamp || new Date().toISOString(),
			source: 'system',
			message
		});
	}

	public addUserStep(message: string, timestamp?: string): void {
		this.steps.push({
			step_id: ++this.stepCounter,
			timestamp: timestamp || new Date().toISOString(),
			source: 'user',
			message
		});
	}

	public beginAgentStep(
		message: string,
		modelName?: string,
		reasoningContent?: string,
		timestamp?: string
	): IAgentStepContext {
		const stepId = ++this.stepCounter;
		const stepTimestamp = timestamp || new Date().toISOString();

		const step: Partial<ITrajectoryStep> = {
			step_id: stepId,
			timestamp: stepTimestamp,
			source: 'agent',
			message,
			model_name: modelName,
			reasoning_content: reasoningContent
		};

		return new AgentStepContext(step, (completedStep) => {
			this.steps.push(completedStep as ITrajectoryStep);
		});
	}

	public build(): IAgentTrajectory {
		// Calculate final metrics
		let totalPromptTokens = 0;
		let totalCompletionTokens = 0;
		let totalCachedTokens = 0;
		let totalCostUsd = 0;
		let totalToolCalls = 0;

		for (const step of this.steps) {
			if (step.metrics) {
				totalPromptTokens += step.metrics.prompt_tokens || 0;
				totalCompletionTokens += step.metrics.completion_tokens || 0;
				totalCachedTokens += step.metrics.cached_tokens || 0;
				totalCostUsd += step.metrics.cost_usd || 0;
			}
			if (step.tool_calls) {
				totalToolCalls += step.tool_calls.length;
			}
		}

		return {
			schema_version: TRAJECTORY_SCHEMA_VERSION,
			session_id: this.sessionId,
			agent: this.agentInfo,
			steps: [...this.steps],
			final_metrics: {
				total_prompt_tokens: totalPromptTokens,
				total_completion_tokens: totalCompletionTokens,
				total_cached_tokens: totalCachedTokens,
				total_cost_usd: totalCostUsd,
				total_steps: this.steps.length,
				total_tool_calls: totalToolCalls
			}
		};
	}
}

/**
 * Context for building an agent step
 */
class AgentStepContext implements IAgentStepContext {
	private toolCalls: IToolCall[] = [];
	private observationResults: IObservationResult[] = [];
	private metrics: IStepMetrics | undefined;

	constructor(
		private readonly step: Partial<ITrajectoryStep>,
		private readonly onComplete: (step: Partial<ITrajectoryStep>) => void
	) { }

	public addToolCalls(toolCalls: IToolCall[]): void {
		this.toolCalls.push(...toolCalls);
	}

	public addObservation(results: IObservationResult[]): void {
		this.observationResults.push(...results);
	}

	public addSubagentReference(toolCallId: string, subagentRef: ISubagentTrajectoryRef): void {
		// Find or create observation result for this tool call
		let result = this.observationResults.find(r => r.source_call_id === toolCallId);
		if (!result) {
			result = { source_call_id: toolCallId };
			this.observationResults.push(result);
		}

		// Add subagent reference
		const mutableResult = result as { subagent_trajectory_ref?: ISubagentTrajectoryRef[] };
		if (!mutableResult.subagent_trajectory_ref) {
			mutableResult.subagent_trajectory_ref = [];
		}
		mutableResult.subagent_trajectory_ref.push(subagentRef);
	}

	public setMetrics(metrics: IStepMetrics): void {
		this.metrics = metrics;
	}

	public complete(): void {
		// Finalize the step (cast to mutable for assignment)
		const mutableStep = this.step as {
			tool_calls?: IToolCall[];
			observation?: { results: IObservationResult[] };
			metrics?: IStepMetrics;
		};
		if (this.toolCalls.length > 0) {
			mutableStep.tool_calls = this.toolCalls;
		}
		if (this.observationResults.length > 0) {
			mutableStep.observation = { results: this.observationResults };
		}
		if (this.metrics) {
			mutableStep.metrics = this.metrics;
		}

		this.onComplete(this.step);
	}
}

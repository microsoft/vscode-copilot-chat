/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * @deprecated Use imports from '../../otel/common/atif/atifTypes' instead.
 * This file re-exports for backward compatibility during migration.
 */
export {
	type IAgentTrajectory,
	type IAgentInfo,
	type IToolDefinition,
	type ITrajectoryStep,
	type IToolCall,
	type IObservation,
	type IObservationResult,
	type ISubagentTrajectoryRef,
	type IStepMetrics,
	type IFinalMetrics,
	type IContentPart,
	type ITextContentPart,
	type IImageContentPart,
	type IImageSource,
	TRAJECTORY_SCHEMA_VERSION,
	TRAJECTORY_FILE_EXTENSION,
	TRAJECTORY_BUNDLE_FILE_EXTENSION,
} from '../../otel/common/atif/atifTypes';

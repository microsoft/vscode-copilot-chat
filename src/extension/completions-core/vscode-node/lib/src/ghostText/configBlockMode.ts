/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// The following code was moved from config.ts into here to break the cyclic dependencies

import { ConfigKey, getConfig } from '../config';
import { Context } from "../context";
import { Features } from "../experiments/features";
import { BlockTrimmer } from './blockTrimmer';
import { TelemetryWithExp } from "../telemetry";
import { isSupportedLanguageId } from '../../../prompt/src/parse';
import { BlockMode } from "../../../../../completions/common/config";
import { StatementTree } from "./statementTree";

export abstract class BlockModeConfig {
	abstract forLanguage(ctx: Context, languageId: string, telemetryData: TelemetryWithExp): BlockMode;
}

export class ConfigBlockModeConfig extends BlockModeConfig {
	forLanguage(ctx: Context, languageId: string, telemetryData: TelemetryWithExp): BlockMode {
		const overrideBlockMode = ctx.get(Features).overrideBlockMode(telemetryData);
		if (overrideBlockMode) {
			return toApplicableBlockMode(overrideBlockMode, languageId);
		}
		const progressiveReveal = ctx.get(Features).enableProgressiveReveal(telemetryData);
		const config = getConfig(ctx, ConfigKey.AlwaysRequestMultiline);
		if (config ?? progressiveReveal) {
			return toApplicableBlockMode(BlockMode.MoreMultiline, languageId);
		}

		if (BlockTrimmer.isTrimmedByDefault(languageId)) {
			return toApplicableBlockMode(BlockMode.MoreMultiline, languageId);
		}
		// special casing once cancellations based on tree-sitter propagate to
		// the proxy.
		if (languageId === 'ruby') {
			return BlockMode.Parsing;
		}
		// For existing multiline languages use standard tree-sitter based parsing
		// plus proxy-side trimming
		if (isSupportedLanguageId(languageId)) {
			return BlockMode.ParsingAndServer;
		}
		return BlockMode.Server;
	}
}

function blockModeRequiresTreeSitter(blockMode: BlockMode): boolean {
	return [BlockMode.Parsing, BlockMode.ParsingAndServer, BlockMode.MoreMultiline].includes(blockMode);
}

/**
 * Prevents tree-sitter parsing from being applied to languages we don't include
 * parsers for.
 */
function toApplicableBlockMode(blockMode: BlockMode, languageId: string): BlockMode {
	if (blockMode === BlockMode.MoreMultiline && StatementTree.isSupported(languageId)) {
		return blockMode;
	}
	if (blockModeRequiresTreeSitter(blockMode) && !isSupportedLanguageId(languageId)) {
		return BlockMode.Server;
	}
	return blockMode;
}

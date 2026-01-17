/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
import { execFileSync } from 'child_process';
import type { Uri } from 'vscode';
import { ILogService } from '../../../platform/log/common/logService';
import { LRUCache } from '../../../util/vs/base/common/map';
import { PromptPathRepresentationService } from '../common/promptPathRepresentationService';

/**
 * Pattern to detect 8.3 short filename segments (e.g., PROGRA~1, DOCUME~2)
 * Format: 1-6 characters, followed by tilde and 1+ digits
 */
const SHORT_NAME_SEGMENT_PATTERN = /^[^~]{1,6}~\d+$/i;

/**
 * Checks if a path segment looks like an 8.3 short filename
 */
function isShortNameSegment(segment: string): boolean {
	// Remove extension if present for checking the base name
	const dotIndex = segment.lastIndexOf('.');
	const baseName = dotIndex > 0 ? segment.substring(0, dotIndex) : segment;
	return SHORT_NAME_SEGMENT_PATTERN.test(baseName);
}

/**
 * Checks if a Windows path contains any 8.3 short name segments
 */
function containsShortNameSegments(filePath: string): boolean {
	const segments = filePath.split(/[\\/]/);
	return segments.some(isShortNameSegment);
}

export class PromptPathRepresentationServiceNode extends PromptPathRepresentationService {
	/**
	 * Cache mapping short path prefixes to their resolved long form.
	 * For example: "C:\PROGRA~1" -> "C:\Program Files"
	 * This allows reuse across files in the same short-named directory.
	 */
	private readonly _shortPrefixToLongPath = new LRUCache<string, string>(64);

	constructor(
		@ILogService private readonly _logService: ILogService,
	) {
		super();
	}

	override getFilePath(uri: Uri): string {
		let filePath = super.getFilePath(uri);
		if (this.isWindows()) {
			filePath = this._tryResolveLongPath(filePath);
		}
		return filePath;
	}

	override resolveFilePath(filepath: string, predominantScheme?: string): Uri | undefined {
		if (this.isWindows()) {
			filepath = this._tryResolveLongPath(filepath);
		}
		return super.resolveFilePath(filepath, predominantScheme);
	}

	/**
	 * Attempts to resolve 8.3 short paths to their long form by resolving each
	 * short segment individually. This allows caching of directory prefixes
	 * for reuse across multiple files.
	 *
	 * For example, given paths:
	 * - `C:\PROGRA~1\foo.txt`
	 * - `C:\PROGRA~1\bar.txt`
	 *
	 * Only one shell call is needed because `C:\PROGRA~1` is cached after the first resolution.
	 */
	private _tryResolveLongPath(filePath: string): string {
		if (!containsShortNameSegments(filePath)) {
			return filePath;
		}

		// Detect the separator used in the path
		const separator = filePath.includes('/') ? '/' : '\\';
		const segments = filePath.split(/[\\/]/);
		const resolvedSegments: string[] = [];

		for (let i = 0; i < segments.length; i++) {
			const segment = segments[i];
			resolvedSegments.push(segment);

			if (!isShortNameSegment(segment)) {
				continue;
			}

			// Build the current prefix path (with short segment)
			const shortPrefix = resolvedSegments.join(separator);
			const cacheKey = shortPrefix.toLowerCase();

			// Check cache first
			const cached = this._shortPrefixToLongPath.get(cacheKey);
			if (cached !== undefined) {
				// Replace resolvedSegments with the cached long path segments
				resolvedSegments.length = 0;
				resolvedSegments.push(...cached.split(/[\\/]/));
				continue;
			}

			// Resolve via shell
			try {
				const longPrefix = this._resolveLongPathViaShell(shortPrefix);
				this._shortPrefixToLongPath.set(cacheKey, longPrefix);
				// Replace resolvedSegments with the resolved long path segments
				resolvedSegments.length = 0;
				resolvedSegments.push(...longPrefix.split(/[\\/]/));
			} catch (error) {
				const errorMessage = error instanceof Error ? error.message : String(error);
				this._logService.warn(`Failed to resolve 8.3 short path "${shortPrefix}": ${errorMessage}`);
				// Cache the short prefix to avoid repeated failures
				this._shortPrefixToLongPath.set(cacheKey, shortPrefix);
			}
		}

		return resolvedSegments.join(separator);
	}

	/**
	 * Uses PowerShell to resolve an 8.3 short path to its long form.
	 * Uses environment variables to safely pass the path without shell injection risks.
	 * Protected to allow overriding in tests.
	 */
	protected _resolveLongPathViaShell(shortPath: string): string {
		const result = execFileSync('powershell.exe', [
			'-NoProfile',
			'-NonInteractive',
			'-NoLogo',
			'-Command',
			'(Get-Item $env:VSCODE_SHORT_PATH).FullName'
		], {
			encoding: 'utf8',
			timeout: 5000,
			env: {
				...process.env,
				VSCODE_SHORT_PATH: shortPath
			},
			windowsHide: true
		});

		return result.trim();
	}
}

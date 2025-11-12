/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { IFileSystemService } from '../../../platform/filesystem/common/fileSystemService';
import { FileType } from '../../../platform/filesystem/common/fileTypes';
import { getWorkspaceFileDisplayPath, IWorkspaceService } from '../../../platform/workspace/common/workspaceService';
import { CancellationToken } from '../../../util/vs/base/common/cancellation';
import { Location, Position, Range, Uri } from '../../../vscodeTypes';
import { coalesceParts, LinkifiedPart, LinkifiedText, LinkifyLocationAnchor } from './linkifiedText';
import { IContributedLinkifier, LinkifierContext } from './linkifyService';

// Matches markdown links where the text is a path and optional #L anchor is present
// Example: [src/file.ts](src/file.ts#L10-12) or [src/file.ts](src/file.ts)
const modelLinkRe = /\[(?<text>[^\]\n]+)\]\((?<target>[^\s)]+)\)/gu;

export class ModelFilePathLinkifier implements IContributedLinkifier {
	constructor(
		@IFileSystemService private readonly fileSystem: IFileSystemService,
		@IWorkspaceService private readonly workspaceService: IWorkspaceService,
	) { }

	async linkify(text: string, context: LinkifierContext, token: CancellationToken): Promise<LinkifiedText | undefined> {
		let lastIndex = 0;
		const parts: Array<LinkifiedPart | Promise<LinkifiedPart>> = [];

		for (const match of text.matchAll(modelLinkRe)) {
			const original = match[0];
			const prefix = text.slice(lastIndex, match.index);
			if (prefix) {
				parts.push(prefix);
			}
			lastIndex = match.index + original.length;

			const parsed = this.parseModelLinkMatch(match);
			if (!parsed) {
				parts.push(original);
				continue;
			}

			const workspaceFolders = this.workspaceService.getWorkspaceFolders();
			if (!this.canLinkify(parsed, workspaceFolders)) {
				parts.push(original);
				continue;
			}

			const resolved = await this.resolveTarget(parsed.targetPath, workspaceFolders, parsed.preserveDirectorySlash);
			if (!resolved) {
				parts.push(original);
				continue;
			}

			const basePath = getWorkspaceFileDisplayPath(this.workspaceService, resolved);
			const anchorRange = this.parseAnchor(parsed.anchor);
			if (parsed.anchor && !anchorRange) {
				parts.push(original);
				continue;
			}

			if (anchorRange) {
				const { range, startLine, endLine } = anchorRange;
				const displayPath = endLine && startLine !== endLine
					? `${basePath}#L${startLine}-${endLine}`
					: `${basePath}#L${startLine}`;
				parts.push(new LinkifyLocationAnchor(new Location(resolved, range), displayPath));
				continue;
			}

			parts.push(new LinkifyLocationAnchor(resolved, basePath));
		}

		const suffix = text.slice(lastIndex);
		if (suffix) {
			parts.push(suffix);
		}

		if (!parts.length) {
			return undefined;
		}

		return { parts: coalesceParts(await Promise.all(parts)) };
	}

	private parseModelLinkMatch(match: RegExpMatchArray): { readonly text: string; readonly targetPath: string; readonly anchor: string | undefined; readonly preserveDirectorySlash: boolean } | undefined {
		const rawText = match.groups?.['text'];
		const rawTarget = match.groups?.['target'];
		if (!rawText || !rawTarget) {
			return undefined;
		}

		const hashIndex = rawTarget.indexOf('#');
		const baseTarget = hashIndex === -1 ? rawTarget : rawTarget.slice(0, hashIndex);
		const anchor = hashIndex === -1 ? undefined : rawTarget.slice(hashIndex + 1);

		let decodedBase = baseTarget;
		try {
			decodedBase = decodeURIComponent(baseTarget);
		} catch {
			// noop
		}

		const preserveDirectorySlash = decodedBase.endsWith('/') && decodedBase.length > 1;
		const normalizedTarget = this.normalizeSlashes(decodedBase);
		const normalizedText = this.normalizeLinkText(rawText);
		return { text: normalizedText, targetPath: normalizedTarget, anchor, preserveDirectorySlash };
	}

	private normalizeSlashes(value: string): string {
		// Collapse one or more backslashes into a single forward slash so mixed separators normalize consistently.
		return value.replace(/\\+/g, '/');
	}

	private normalizeLinkText(rawText: string): string {
		let text = this.normalizeSlashes(rawText);
		// Remove a leading or trailing backtick that sometimes wraps the visible link label.
		text = text.replace(/^`|`$/g, '');

		// Look for a trailing #L anchor segment so it can be stripped before we compare names.
		const anchorMatch = /^(.+?)(#L\d+(?:-\d+)?)$/.exec(text);
		return anchorMatch ? anchorMatch[1] : text;
	}

	private canLinkify(parsed: { readonly text: string; readonly targetPath: string; readonly anchor: string | undefined }, workspaceFolders: readonly Uri[]): boolean {
		const { text, targetPath, anchor } = parsed;
		const textMatchesBase = targetPath === text;
		const textIsFilename = !text.includes('/') && targetPath.endsWith(`/${text}`);
		const descriptiveAbsolute = this.isAbsolutePath(targetPath) && !!anchor;

		return Boolean(workspaceFolders.length) && (textMatchesBase || textIsFilename || descriptiveAbsolute);
	}

	private async resolveTarget(targetPath: string, workspaceFolders: readonly Uri[], preserveDirectorySlash: boolean): Promise<Uri | undefined> {
		if (!workspaceFolders.length) {
			return undefined;
		}

		const folderUris = workspaceFolders.map(folder => this.toVsUri(folder));

		if (this.isAbsolutePath(targetPath)) {
			const absoluteUri = this.tryCreateFileUri(targetPath);
			if (!absoluteUri) {
				return undefined;
			}

			for (const folderUri of folderUris) {
				if (this.isEqualOrParentFs(absoluteUri, folderUri)) {
					return this.tryStat(absoluteUri, preserveDirectorySlash);
				}
			}
			return undefined;
		}

		const segments = targetPath.split('/').filter(Boolean);
		for (const folderUri of folderUris) {
			const candidate = Uri.joinPath(folderUri, ...segments);
			const stat = await this.tryStat(candidate, preserveDirectorySlash);
			if (stat) {
				return stat;
			}
		}

		return undefined;
	}

	private tryCreateFileUri(path: string): Uri | undefined {
		try {
			return Uri.file(path);
		} catch {
			return undefined;
		}
	}

	private toVsUri(folder: Uri): Uri {
		return Uri.parse(folder.toString());
	}

	private isEqualOrParentFs(target: Uri, folder: Uri): boolean {
		const targetFs = this.normalizeFsPath(target);
		const folderFs = this.normalizeFsPath(folder);
		return targetFs === folderFs || targetFs.startsWith(folderFs.endsWith('/') ? folderFs : `${folderFs}/`);
	}

	private normalizeFsPath(resource: Uri): string {
		// Convert Windows backslashes to forward slashes and remove duplicate separators for stable comparisons.
		return resource.fsPath.replace(/\\/g, '/').replace(/\/+/g, '/').toLowerCase();
	}

	private parseAnchor(anchor: string | undefined): { readonly range: Range; readonly startLine: string; readonly endLine: string | undefined } | undefined {
		// Ensure the anchor follows the #L123 or #L123-456 format before parsing it.
		if (!anchor || !/^L\d+(?:-\d+)?$/.test(anchor)) {
			return undefined;
		}

		// Capture the start (and optional end) line numbers from the anchor.
		const match = /^L(\d+)(?:-(\d+))?$/.exec(anchor);
		if (!match) {
			return undefined;
		}

		const startLine = match[1];
		const endLineRaw = match[2];
		const normalizedEndLine = endLineRaw === startLine ? undefined : endLineRaw;
		const start = parseInt(startLine, 10) - 1;
		const end = parseInt(normalizedEndLine ?? startLine, 10) - 1;
		if (Number.isNaN(start) || Number.isNaN(end) || start < 0 || end < start) {
			return undefined;
		}

		return {
			range: new Range(new Position(start, 0), new Position(end, 0)),
			startLine,
			endLine: normalizedEndLine,
		};
	}

	private isAbsolutePath(path: string): boolean {
		// Treat drive-letter prefixes (e.g. C:) or leading slashes as absolute paths.
		return /^[a-z]:/i.test(path) || path.startsWith('/');
	}

	private async tryStat(uri: Uri, preserveDirectorySlash: boolean): Promise<Uri | undefined> {
		try {
			const stat = await this.fileSystem.stat(uri);
			if (stat.type === FileType.Directory) {
				if (preserveDirectorySlash) {
					return uri.path.endsWith('/') ? uri : uri.with({ path: `${uri.path}/` });
				}
				if (uri.path.endsWith('/') && uri.path !== '/') {
					return uri.with({ path: uri.path.slice(0, -1) });
				}
				return uri;
			}
			return uri;
		} catch {
			return undefined;
		}
	}
}

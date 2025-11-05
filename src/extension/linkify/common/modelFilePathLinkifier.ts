/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { IFileSystemService } from '../../../platform/filesystem/common/fileSystemService';
import { FileType } from '../../../platform/filesystem/common/fileTypes';
import { IWorkspaceService } from '../../../platform/workspace/common/workspaceService';
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
		const out: Array<LinkifiedPart | Promise<LinkifiedPart>> = [];

		for (const match of text.matchAll(modelLinkRe)) {
			const prefix = text.slice(lastIndex, match.index);
			if (prefix) {
				out.push(prefix);
			}
			lastIndex = match.index + match[0].length;

			const rawText = match.groups?.['text'] ?? '';
			const rawTarget = match.groups?.['target'] ?? '';

			const hashIndex = rawTarget.indexOf('#');
			const baseTarget = hashIndex === -1 ? rawTarget : rawTarget.slice(0, hashIndex);
			const anchor = hashIndex === -1 ? undefined : rawTarget.slice(hashIndex + 1);

			let decodedBase = baseTarget;
			try { decodedBase = decodeURIComponent(baseTarget); } catch { }

			if (decodedBase !== rawText) {
				out.push(match[0]);
				continue;
			}

			const workspaceFolders = this.workspaceService.getWorkspaceFolders();
			let resolved: Uri | undefined;
			for (const folder of workspaceFolders) {
				const candidate = Uri.joinPath(folder, decodedBase);
				const stat = await this.tryStat(candidate);
				if (stat) { resolved = stat; break; }
			}
			if (!resolved) {
				out.push(match[0]);
				continue;
			}

			if (anchor && /^L\d+(?:-\d+)?$/.test(anchor)) {
				const m = /^L(\d+)(?:-(\d+))?$/.exec(anchor);
				if (m) {
					const start = parseInt(m[1], 10) - 1;
					const end = (m[2] ? parseInt(m[2], 10) : parseInt(m[1], 10)) - 1;
					if (start >= 0 && end >= start) {
						try { console.log('[linkify][model] linkified range', { path: decodedBase, anchor, requestId: context.requestId }); } catch { }
						out.push(new LinkifyLocationAnchor(new Location(resolved, new Range(new Position(start, 0), new Position(end, 0)))));
						continue;
					}
				}
			}
			try { console.log('[linkify][model] linkified file', { path: decodedBase, requestId: context.requestId }); } catch { }
			out.push(new LinkifyLocationAnchor(resolved));
		}

		const suffix = text.slice(lastIndex);
		if (suffix) { out.push(suffix); }

		if (!out.length) {
			return undefined;
		}
		return { parts: coalesceParts(await Promise.all(out)) };
	}

	private async tryStat(uri: Uri): Promise<Uri | undefined> {
		try {
			const stat = await this.fileSystem.stat(uri);
			if (stat.type === FileType.Directory) {
				return uri.path.endsWith('/') ? uri : uri.with({ path: uri.path + '/' });
			}
			return uri;
		} catch { return undefined; }
	}
}

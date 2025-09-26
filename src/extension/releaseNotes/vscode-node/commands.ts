import * as vscode from 'vscode';
import { Disposable } from '../../../util/vs/base/common/lifecycle';
import { IReleaseNotesService } from '../../../platform/releaseNotes/common/releaseNotesService';

export class ReleaseNotesCommandContribution extends Disposable {
    constructor(@IReleaseNotesService private readonly releaseNotesService: IReleaseNotesService) {
        super();
        this._register(vscode.commands.registerCommand('github.copilot.open.releaseNotes', async () => {
            const notes = await this.releaseNotesService.fetchLatestReleaseNotes();
            if (!notes) {
                vscode.window.showInformationMessage('Unable to fetch release notes.');
                return;
            }
            const doc = await vscode.workspace.openTextDocument({ content: notes, language: 'markdown' });
            await vscode.window.showTextDocument(doc, { preview: false });
        }));
    }
}


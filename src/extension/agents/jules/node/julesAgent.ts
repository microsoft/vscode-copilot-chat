/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { ILogService } from '../../../../platform/log/common/logService';
import { IInstantiationService } from '../../../../util/vs/platform/instantiation/common/instantiation';
import { Disposable } from '../../../../util/vs/base/common/lifecycle';
import { IBYOKStorageServiceLike } from '../../../byok/common/byokProvider';
import { JulesProvider } from '../../../byok/vscode-node/julesProvider';

interface JulesSession {
    name: string;
    id: string;
    prompt: string;
    title: string;
    state: string;
    url: string;
    createTime: string;
    updateTime: string;
    outputs?: {
        pullRequest?: {
            url: string;
            title: string;
            description: string;
        }
    }[];
}

interface JulesActivity {
    name: string;
    id: string;
    originator: string;
    description: string;
    createTime: string;
    agentMessaged?: {
        agentMessage: string;
    };
    userMessaged?: {
        userMessage: string;
    };
    planGenerated?: any;
    planApproved?: any;
    progressUpdated?: {
        title: string;
        description: string;
    };
    sessionCompleted?: any;
    sessionFailed?: {
        reason: string;
    };
    artifacts?: any[];
}

export class JulesAgent extends Disposable {
    private static readonly BaseURL = 'https://jules.googleapis.com/v1alpha';

    constructor(
        @ILogService private readonly _logService: ILogService,
        @IInstantiationService private readonly _instantiationService: IInstantiationService,
        private readonly _byokStorageService: IBYOKStorageServiceLike // Removed decorator as it is passed explicitly
    ) {
        super();
        this._register(vscode.chat.createChatParticipant('jules', this.handler.bind(this)));
    }

    private async handler(
        request: vscode.ChatRequest,
        context: vscode.ChatContext,
        stream: vscode.ChatResponseStream,
        token: vscode.CancellationToken
    ): Promise<vscode.ChatResult | void> {
        this._logService.info('[JulesAgent] Handling request');

        const apiKey = await this._byokStorageService.getAPIKey(JulesProvider.providerName.toLowerCase());
        if (!apiKey) {
            stream.markdown('Please provide a Jules API key using the `GitHub Copilot: Manage Bring Your Own Key API Key` command and selecting "Jules".');
            return;
        }

        try {
            // Check for existing session in history or context
            // Note: VS Code Chat API doesn't persist custom session state easily across requests unless we use the history or a map.
            // For simplicity, we'll assume a new session or try to infer from context if possible.
            // But since `context.history` gives previous messages, we might need to store the session ID in a way we can retrieve it.
            // For now, let's treat every request as a potential new session OR a message to an ongoing session if we can find a session ID in the history (not easy).

            // Actually, we can use a map keyed by the vscode session ID (if available, but `context` doesn't give a stable session ID for the chat window itself easily in all versions).
            // `vscode.chat.createChatParticipant` doesn't pass a session object, but `context` has `history`.

            // Let's create a new session for now if it's the first turn, or try to continue if we can.
            // Since we can't easily persist state per chat window without a session ID from VS Code,
            // we will create a new session for the first request.

            // Wait, `context` might have metadata? No.

            // Let's just implement creating a session and polling for now.

            stream.progress('Initializing Jules session...');
            const session = await this.createSession(apiKey, request.prompt);
            stream.markdown(`Started Jules Session: [${session.id}](${session.url})\n\n`);

            await this.monitorSession(apiKey, session.id, stream, token);

        } catch (err: any) {
            this._logService.error('[JulesAgent] Error:', err);
            stream.markdown(`Error: ${err.message}`);
        }
    }

    private async createSession(apiKey: string, prompt: string): Promise<JulesSession> {
        const sources = await this.listSources(apiKey);
        if (sources.length === 0) {
            throw new Error('No sources found. Please connect a repository in Jules settings.');
        }

        // Try to match the current workspace folder name with the repository name
        let matchedSource: any | undefined;
        if (sources.length === 1) {
            matchedSource = sources[0];
        }

        const workspaceFolders = vscode.workspace.workspaceFolders;

        if (workspaceFolders && workspaceFolders.length > 0) {
            const currentFolder = workspaceFolders[0].name.toLowerCase();
            // Assuming source name format "sources/github-owner-repo" or "sources/github-org-repo"
            // We'll look for the repo name at the end
            const matches = sources.filter(s => {
                return s.name.toLowerCase().includes(currentFolder) || (s.githubRepo && s.githubRepo.repo.toLowerCase() === currentFolder);
            });

            if (matches.length > 0) {
                matchedSource = matches[0];
            }
        }

        if (!matchedSource) {
             throw new Error(`Multiple sources found (${sources.map((s: any) => s.name).join(', ')}). Could not automatically determine which one to use for the current workspace. Please ensure your workspace folder matches the repository name.`);
        }

        const source = matchedSource.name;

        let branch = matchedSource.githubRepo?.defaultBranch?.displayName || 'main';
        try {
            const gitExtension = vscode.extensions.getExtension('vscode.git');
            if (gitExtension) {
                const git = gitExtension.exports.getAPI(1);
                if (git.repositories.length > 0) {
                    const repo = git.repositories[0];
                    if (repo.state.HEAD?.name) {
                        branch = repo.state.HEAD.name;
                    }
                }
            }
        } catch (e) {
            // Ignore error, fallback to default branch
            this._logService.warn('[JulesAgent] Failed to get git branch:', e);
        }

        const response = await fetch(`${JulesAgent.BaseURL}/sessions`, {
            method: 'POST',
            headers: {
                'x-goog-api-key': apiKey,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                prompt: prompt,
                sourceContext: {
                    source: source,
                    githubRepoContext: {
                        startingBranch: branch
                    }
                }
            })
        });

        if (!response.ok) {
            const text = await response.text();
            throw new Error(`Failed to create session: ${response.status} ${text}`);
        }

        return await response.json() as JulesSession;
    }

    private async listSources(apiKey: string): Promise<any[]> {
        const response = await fetch(`${JulesAgent.BaseURL}/sources?pageSize=10`, {
            headers: {
                'x-goog-api-key': apiKey
            }
        });

        if (!response.ok) {
             const text = await response.text();
            throw new Error(`Failed to list sources: ${response.status} ${text}`);
        }

        const data = await response.json() as any;
        return data.sources || [];
    }

    private async monitorSession(apiKey: string, sessionId: string, stream: vscode.ChatResponseStream, token: vscode.CancellationToken): Promise<void> {
        let pageToken = '';
        const seenActivities = new Set<string>();

        while (!token.isCancellationRequested) {
            const url = new URL(`${JulesAgent.BaseURL}/sessions/${sessionId}/activities`);
            if (pageToken) {
                url.searchParams.append('pageToken', pageToken);
            }

            const response = await fetch(url.toString(), {
                headers: {
                    'x-goog-api-key': apiKey
                }
            });

            if (!response.ok) {
                 // Ignore transient errors or break?
                 await new Promise(resolve => setTimeout(resolve, 5000));
                 continue;
            }

            const data = await response.json() as any;
            const activities = data.activities as JulesActivity[] || [];

            for (const activity of activities) {
                if (seenActivities.has(activity.id)) {
                    continue;
                }
                seenActivities.add(activity.id);

                if (activity.agentMessaged) {
                    stream.markdown(activity.agentMessaged.agentMessage + '\n\n');
                } else if (activity.progressUpdated) {
                    stream.progress(activity.progressUpdated.description);
                } else if (activity.planGenerated) {
                    stream.markdown('**Plan Generated**\n');
                    // Render plan steps?
                } else if (activity.sessionCompleted) {
                    stream.markdown('**Session Completed**\n');
                    return;
                } else if (activity.sessionFailed) {
                    stream.markdown(`**Session Failed**: ${activity.sessionFailed.reason}\n`);
                    return;
                }

                // Handle artifacts if needed
            }

            if (data.nextPageToken) {
                pageToken = data.nextPageToken;
            }

            // Poll interval
            await new Promise(resolve => setTimeout(resolve, 2000));
        }
    }
}

const fs = require('fs');
let code = fs.readFileSync('src/extension/conversation/vscode-node/sidecarContribution.ts', 'utf8');

const regexes = [
	/^[ \t]*private async tryResolveViaCodeTunnelCli[\s\S]*?\n[ \t]*\}\n/gm,
	/^[ \t]*private async tryAutoCreateDevTunnel[\s\S]*?\n[ \t]*\}\n/gm,
	/^[ \t]*private async tryActivateVsCodeTunnelResources[\s\S]*?\n[ \t]*\}\n/gm,
	/^[ \t]*private async tryRunTunnelBootstrapCommands[\s\S]*?\n[ \t]*\}\n/gm,
	/^[ \t]*private async tryRunCodeTunnelBootstrap[\s\S]*?\n[ \t]*\}\n/gm,
	/^[ \t]*private ensureWorkspacePathOnVsCodeTunnelUri[\s\S]*?\n[ \t]*\}\n/gm,
	/^[ \t]*private async tryStartCodeTunnelProcessForUri[\s\S]*?\n[ \t]*\}\n/gm,
	/^[ \t]*private getCodeTunnelWorkingDirectory[\s\S]*?\n[ \t]*\}\n/gm,
	/^[ \t]*private waitForVsCodeTunnelUri[\s\S]*?\n[ \t]*\}\n/gm,
	/^[ \t]*private getCodeCliCandidates[\s\S]*?\n[ \t]*\}\n/gm,
	/^[ \t]*private runCodeCliCommand[\s\S]*?\n[ \t]*\}\n/gm,
	/^[ \t]*private extractTunnelUriFromCommandResult[\s\S]*?\n[ \t]*\}\n/gm,
	/^[ \t]*private extractVsCodeTunnelUri[\s\S]*?\n[ \t]*\}\n/gm,
	/^[ \t]*private attachCodeTunnelProcessLifecycle[\s\S]*?\n[ \t]*\}\n/gm,
	/^[ \t]*private stopCodeTunnelProcess[\s\S]*?\n[ \t]*\}\n/gm,
	/^[ \t]*private terminateCodeTunnelProcess[\s\S]*?\n[ \t]*\}\n/gm
];

for (const r of regexes) {
	code = code.replace(r, '\n');
}

fs.writeFileSync('src/extension/conversation/vscode-node/sidecarContribution.ts', code);

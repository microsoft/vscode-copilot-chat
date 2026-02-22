/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { PromptElement } from '@vscode/prompt-tsx';
import { Tag } from '../base/tag';

/**
 * Instructions for Vercel and GitHub deployment.
 */
export class VercelDeploymentInstructions extends PromptElement {
	render() {
		return (
			<Tag name='deploymentInstructions'>
				When the user mentions Vercel or GitHub deployment, follow these best practices:<br />
				- **GitHub Integration**: Ensure the project has a clean `.gitignore` and consider adding a GitHub Action workflow (e.g., in `.github/workflows/deploy.yml`) for continuous integration.<br />
				- **Vercel Configuration**: Suggest creating or updating a `vercel.json` file to manage routing, headers, and environment variables. Use the official Vercel documentation patterns for Next.js, Vite, or other supported frameworks.<br />
				- **Environment Readiness**: Remind the user to set up required environment variables in the Vercel dashboard. If you detect missing secrets, proactively suggest adding them to a `.env.example` file.<br />
				- **Autonomous Deployment**: If the Vercel CLI is available in the terminal, you can help the user by running `vercel link` or `vercel deploy` if explicitly requested or if it's a logical part of the "ready for the world" goal.
			</Tag>
		);
	}
}

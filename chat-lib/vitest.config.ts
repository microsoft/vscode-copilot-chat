/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as path from 'path';
import { loadEnv } from 'vite';
import { defineConfig } from 'vitest/config';

export default defineConfig(({ mode }) => ({
	test: {
		include: ['**/*.spec.ts', '**/*.spec.tsx'],
		exclude: [
			'**/node_modules/**',
			'**/dist/**',
			'**/.{idea,git,cache,output,temp}/**'
		],
		env: loadEnv(mode, process.cwd(), ''),
		alias: {
			// similar to aliasing in the esbuild config `.esbuild.ts`
			// vitest requires aliases to be absolute paths. reference: https://vitejs.dev/config/shared-options#resolve-alias
			'vscode': path.resolve(__dirname, 'src/_internal/util/common/test/shims/vscodeTypesShim.ts'),
		},
		environment: 'node',
		globals: true
	}
}));
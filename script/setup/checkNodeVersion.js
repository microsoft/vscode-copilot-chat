/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

/**
 * Check if the current Node.js version meets the project requirements
 */
function checkNodeVersion() {
	const packageJsonPath = path.join(__dirname, '../../package.json');
	const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));
	
	const requiredNodeVersion = packageJson.engines?.node;
	if (!requiredNodeVersion) {
		console.log('No Node.js version requirement found in package.json');
		return;
	}
	
	const currentNodeVersion = process.version;
	console.log(`Current Node.js version: ${currentNodeVersion}`);
	console.log(`Required Node.js version: ${requiredNodeVersion}`);
	
	// Extract version number (remove 'v' prefix)
	const currentVersion = currentNodeVersion.slice(1);
	
	// Simple version check for >=22.14.0 format
	const requiredMatch = requiredNodeVersion.match(/>=(\d+)\.(\d+)\.(\d+)/);
	if (!requiredMatch) {
		console.warn('Could not parse required Node.js version format');
		return;
	}
	
	const [, reqMajor, reqMinor, reqPatch] = requiredMatch.map(Number);
	const [currentMajor, currentMinor, currentPatch] = currentVersion.split('.').map(Number);
	
	const isVersionValid = 
		currentMajor > reqMajor || 
		(currentMajor === reqMajor && currentMinor > reqMinor) ||
		(currentMajor === reqMajor && currentMinor === reqMinor && currentPatch >= reqPatch);
	
	if (!isVersionValid) {
		console.error('\n❌ Node.js version requirement not met!');
		console.error(`Required: ${requiredNodeVersion}`);
		console.error(`Current:  ${currentNodeVersion}`);
		console.error('\nPlease upgrade your Node.js version to continue.');
		console.error('\n📋 Installation Options:');
		console.error('\n1. Using Node Version Manager (nvm) - Recommended:');
		console.error('   nvm install 22.15.1');
		console.error('   nvm use 22.15.1');
		console.error('\n2. Manual installation:');
		console.error('   Download from: https://nodejs.org/');
		console.error('   Install Node.js 22.x or higher');
		console.error('\n3. Using package managers:');
		console.error('   # Using Homebrew (macOS)');
		console.error('   brew install node@22');
		console.error('   # Using winget (Windows)');
		console.error('   winget install OpenJS.NodeJS');
		console.error('\nAfter installation, restart your terminal and try again.');
		process.exit(1);
	}
	
	console.log('✅ Node.js version requirement satisfied');
}

/**
 * Check if the current npm version meets the project requirements
 */
function checkNpmVersion() {
	const packageJsonPath = path.join(__dirname, '../../package.json');
	const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));
	
	const requiredNpmVersion = packageJson.engines?.npm;
	if (!requiredNpmVersion) {
		return;
	}
	
	try {
		const currentNpmVersion = execSync('npm --version', { encoding: 'utf8' }).trim();
		console.log(`Current npm version: ${currentNpmVersion}`);
		console.log(`Required npm version: ${requiredNpmVersion}`);
		
		// Simple check for >=9.0.0 format
		const requiredMatch = requiredNpmVersion.match(/>=(\d+)\.(\d+)\.(\d+)/);
		if (!requiredMatch) {
			console.warn('Could not parse required npm version format');
			return;
		}
		
		const [, reqMajor] = requiredMatch.map(Number);
		const [currentMajor] = currentNpmVersion.split('.').map(Number);
		
		if (currentMajor >= reqMajor) {
			console.log('✅ npm version requirement satisfied');
		} else {
			console.warn('⚠️  npm version may be outdated');
			console.warn(`Consider upgrading npm: npm install -g npm@latest`);
		}
	} catch (error) {
		console.warn('Could not check npm version');
	}
}

/**
 * Check for GitHub Copilot setup prerequisites
 */
function checkCopilotPrerequisites() {
	console.log('\n🤖 GitHub Copilot Development Setup:');
	
	// Check if .env file exists (for tokens)
	const envPath = path.join(__dirname, '../../.env');
	if (fs.existsSync(envPath)) {
		console.log('✅ .env file found (authentication tokens configured)');
	} else {
		console.log('⚠️  .env file not found');
		console.log('   Run: npm run get_token    # to set up GitHub OAuth token');
		console.log('   Run: npm run get_env      # (Microsoft team members only)');
	}
	
	// Check for Git LFS
	try {
		execSync('git lfs version', { stdio: 'pipe' });
		console.log('✅ Git LFS is installed');
	} catch (error) {
		console.log('❌ Git LFS not found');
		console.log('   Install from: https://git-lfs.com/');
		console.log('   Or use package manager: brew install git-lfs / winget install GitHub.GitLFS');
	}
	
	console.log('\n📚 Next Steps:');
	console.log('1. Sign up for GitHub Copilot: https://github.com/settings/copilot');
	console.log('2. Read setup guide: https://docs.github.com/en/copilot/how-tos/use-copilot-agents/coding-agent/customize-the-agent-environment');
	console.log('3. Run: npm run setup     # to complete authentication setup');
	console.log('4. Start debugging in VS Code with "Launch Copilot Extension - Watch Mode"');
}

function main() {
	console.log('🔍 Checking development environment requirements...\n');
	checkNodeVersion();
	checkNpmVersion();
	checkCopilotPrerequisites();
	console.log('\n✅ Environment check complete!');
}

main();
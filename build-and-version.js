#!/usr/bin/env node

const fs = require('fs');
const { execSync } = require('child_process');
const path = require('path');

// Read package.json
const packagePath = path.join(__dirname, 'package.json');
const packageJson = JSON.parse(fs.readFileSync(packagePath, 'utf8'));

// Get current version
const currentVersion = packageJson.version;
console.log(`Current version: ${currentVersion}`);

// Parse version parts
const versionParts = currentVersion.split('.').map(num => parseInt(num));
let [major, minor, patch] = versionParts;

// Increment version based on argument or default to patch
const versionType = process.argv[2] || 'patch';

switch (versionType) {
	case 'major':
		major++;
		minor = 0;
		patch = 0;
		break;
	case 'minor':
		minor++;
		patch = 0;
		break;
	case 'patch':
	default:
		patch++;
		break;
}

const newVersion = `${major}.${minor}.${patch}`;
console.log(`New version: ${newVersion}`);

// Update package.json
packageJson.version = newVersion;
fs.writeFileSync(packagePath, JSON.stringify(packageJson, null, 2));

console.log('Updated package.json with new version');

// Clean previous builds
console.log('Cleaning previous builds...');
try {
	execSync('rm -rf dist/ .build/', { stdio: 'inherit' });
} catch (error) {
	// Ignore if directories don't exist
}

// Run build
console.log('Building project...');
try {
	execSync('node .esbuild.ts', { stdio: 'inherit' });
	console.log('Build completed successfully!');
} catch (error) {
	console.error('Build failed:', error.message);
	process.exit(1);
}

console.log(`\nProject built and version bumped to ${newVersion}`);
console.log('Usage: node build-and-version.js [major|minor|patch]');

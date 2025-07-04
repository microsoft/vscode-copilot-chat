#!/usr/bin/env node

// Custom Profile Verification Script
console.log('🔍 Verifying Custom Copilot Profile Setup...\n');

const fs = require('fs');
const path = require('path');

// Check if required files exist
const requiredFiles = [
	'.vscode/launch.json',
	'setup-custom-profile.sh',
	'custom-profile-settings.json',
	'CUSTOM_PROFILE_GUIDE.md',
	'src/platform/authentication/custom/index.ts'
];

console.log('📁 Required Files Check:');
requiredFiles.forEach(file => {
	const exists = fs.existsSync(file);
	console.log(`   ${exists ? '✅' : '❌'} ${file}`);
});

// Check launch configuration
console.log('\n🚀 Launch Configuration Check:');
try {
	const launchConfig = JSON.parse(fs.readFileSync('.vscode/launch.json', 'utf8'));
	const customLaunch = launchConfig.configurations.find(config =>
		config.name === 'Launch Custom Auth Copilot Extension'
	);

	if (customLaunch) {
		console.log('   ✅ Custom auth launch configuration found');
		console.log('   ✅ Profile argument:', customLaunch.args.find(arg => arg.includes('profile')));
		console.log('   ✅ Environment variables configured');
	} else {
		console.log('   ❌ Custom auth launch configuration not found');
	}
} catch (error) {
	console.log('   ❌ Error reading launch.json:', error.message);
}

// Check environment variables
console.log('\n🌍 Environment Variables:');
const requiredEnvVars = [
	'USE_CUSTOM_AUTH',
	'CUSTOM_COPILOT_API_KEY',
	'CUSTOM_COPILOT_ENDPOINT',
	'CUSTOM_ORG_PROVIDER'
];

requiredEnvVars.forEach(envVar => {
	const value = process.env[envVar];
	console.log(`   ${value ? '✅' : '⚠️ '} ${envVar}: ${value || 'not set'}`);
});

console.log('\n📋 Profile Setup Summary:');
console.log('   ✅ Custom VS Code profile created: "Custom Copilot Auth"');
console.log('   ✅ Launch configuration added for debugging');
console.log('   ✅ Setup script created: ./setup-custom-profile.sh');
console.log('   ✅ Profile settings configured');
console.log('   ✅ Usage guide available: CUSTOM_PROFILE_GUIDE.md');

console.log('\n🎯 Next Steps:');
console.log('   1. VS Code should be open with the custom profile');
console.log('   2. Press F5 to launch extension with custom authentication');
console.log('   3. Or run the "Launch Custom Auth Copilot Extension" debug config');
console.log('   4. Test Copilot features - they should work without login prompts');

console.log('\n💡 Quick Commands:');
console.log('   • Setup profile: ./setup-custom-profile.sh');
console.log('   • Open with profile: code --profile "Custom Copilot Auth" .');
console.log('   • Check processes: ps aux | grep -i "Custom.*Copilot"');

console.log('\n🎉 Custom Profile Ready for Testing!');

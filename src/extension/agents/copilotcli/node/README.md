Instructions for development with the sdk source
* Copy path to the dist-cli folder `/Users/donjayamanne/Development/vsc/sweagentd/runtime/dist-cli/sdk/index.js`
* Open `vscode-copilot-chat` in VS Code Insiders
* `fnm use` or `nvm use` to switch to the right version of node
* Build the cli tool (e.g. `npm run build:package`)
* Run `npm install /Users/donjayamanne/Development/vsc/sweagentd/runtime/dist-cli/sdk` to install the sdk package from local path
* Run `npm run postinstall` (sometimes you might need to run this manually, for now do this always after installing from local path)
* Modify `esbuild.ts` to exclude the sdk package from being bundled (add the path to the `external` array)
* Modify `copilotcliSessionService.ts` and `copilotcliSession.ts` to import the sdk from the local path instead of `@github/copilot/sdk`
* Exit VS Code completey (don't reload window, you must exit completely)
    * Optionally you can shutdown the build tasks & then run them again using `ctrl+shift+b`
* Start VS Code again
* Build tasks will automatically start running
* Start debugging using the debug view and selecting `Launch Copilot Extension`
* Add breakpoints in extension code & step into the sdk code
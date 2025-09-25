#!/bin/bash
set -e

# Get the OAuth token from the git config
result=$(git config --get-regexp '.*extraheader' '^AUTHORIZATION:')
basicToken=$(echo "$result" | sed 's/.*AUTHORIZATION: basic //')
oauthToken=$(echo "$basicToken" | base64 -d | cut -d':' -f2)

# Get the completions core version from package.json
completionsCoreVersion=$(node -p "require('./package.json').completionsCore")

# Clone the vscode-copilot-completions repository
git clone -b completions-port "https://vscode:$oauthToken@github.com/microsoft/vscode-copilot-completions.git" --depth 1 src/extension/completions-core

# Navigate to the cloned directory and checkout the specific version
pushd src/extension/completions-core
git checkout "$completionsCoreVersion"
popd

# Remove the existing file and rename the .txt version
rm src/extension/completions/vscode-node/completionsCoreContribution.ts
mv src/extension/completions/vscode-node/completionsCoreContribution.ts.txt src/extension/completions/vscode-node/completionsCoreContribution.ts
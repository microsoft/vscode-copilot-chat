#!/bin/bash

# Simple build without version increment
echo "Building project without version increment..."
npx tsx .esbuild.ts

# Create VSIX bundle
echo "Creating VSIX bundle..."
npx vsce package

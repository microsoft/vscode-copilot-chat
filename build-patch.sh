#!/bin/bash

# Build and increment patch version
echo "Building and incrementing patch version..."
node build-and-version.js patch

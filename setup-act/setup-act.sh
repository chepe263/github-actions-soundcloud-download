#!/bin/bash

echo "Setting up act for local GitHub Actions testing..."

# Check if act is already installed
if command -v act &> /dev/null; then
    echo "act is already installed: $(act --version)"
    exit 0
fi

# Download and install act
echo "Downloading act..."
curl -s https://raw.githubusercontent.com/nektos/act/master/install.sh | sudo bash

# Move to PATH
echo "Installing to /usr/local/bin..."
sudo mv ./bin/act /usr/local/bin/

# Verify installation
if command -v act &> /dev/null; then
    echo "✓ act installed successfully: $(act --version)"
else
    echo "✗ Failed to install act"
    exit 1
fi

echo ""
echo "Usage:"
echo "  act                    # Run all workflows"
echo "  act -l                 # List available workflows"
echo "  act -j build           # Run specific job 'build'"
echo "  act --container-architecture linux/amd64  # For better compatibility"

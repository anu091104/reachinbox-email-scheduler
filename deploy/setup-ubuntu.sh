#!/usr/bin/env bash
# One-time setup on a fresh Ubuntu 22.04/24.04 VM: installs Docker + Compose.
set -euo pipefail
sudo apt-get update -y
sudo apt-get install -y ca-certificates curl git
curl -fsSL https://get.docker.com | sudo sh
sudo usermod -aG docker "$USER"
# Elasticsearch needs this kernel setting
echo 'vm.max_map_count=262144' | sudo tee /etc/sysctl.d/99-elasticsearch.conf
sudo sysctl --system >/dev/null
echo "Docker installed. Log out and back in (or run 'newgrp docker'), then continue with DEPLOYMENT.md step 4."

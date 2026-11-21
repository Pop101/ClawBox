# ClawBox

A Docker-based OpenClaw workspace for a personal assistant. It packages the gateway, model settings, and optional communications integrations in one place.

> **Maintenance boundary:** Treat the assistant as a privileged service. Keep credentials out of the repository and restrict third-party access, outbound actions, and data retention before using real accounts.

## Table of Contents

- [What’s here](#whats-here)
- [Technologies](#technologies)

## What’s here

The repository contains container definitions, an example model configuration, and directories for the harness, prompts, and skills. The integrations cover chat and scheduling and depend on separate accounts. This overview does not establish that the packaged configuration is hardened or ready for public use.

## Technologies

- [OpenClaw](https://github.com/openclaw/openclaw) for the assistant gateway.
- [Docker Compose](https://docs.docker.com/compose/) for container orchestration.
- [Supervisor](https://supervisord.org/) for container process management.
- [Kimi](https://www.kimi.com/) for the configured model provider.

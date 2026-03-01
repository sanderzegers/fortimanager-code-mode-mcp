# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- **MCP Server** with 2 tools (`search` + `execute`) using the Code Mode pattern
- **FortiManager JSON-RPC client** with token-based authentication and SSL bypass support
- **QuickJS WASM sandbox** for secure agent code execution (memory/CPU limited)
- **API spec generator** parsing FortiManager HTML docs into structured JSON
- **Dual API version support** — FortiManager 7.4.9 (72 modules, 17,426 objects) and 7.6.5 (82 modules, 22,060 objects)
- **Dual transport** — Stdio (local dev / Claude Desktop) and Streamable HTTP (Docker / production)
- **Docker** multi-stage Alpine build with health checks and non-root user
- **Docker Compose** configuration with env_file support
- **CI/CD pipelines** — GitHub Actions for lint, typecheck, test, build, Docker push, and releases
- **66 unit tests** across 5 suites (client, search executor, code executor, server, config)
- **21 integration tests** validated against a live FortiManager v7.6.6 VM
- **86 integration tests** (expanded from 21) across 8 groups: spec globals, edge cases, cross-reference validation, system ops, CRUD lifecycle, error handling, advanced operations, and stability stress tests
- **API coverage report** (`scripts/spec-coverage.ts`) — offline spec analysis, cross-version comparison (v7.4 vs v7.6), and live URL validation with stratified sampling (96% validation rate on 100-URL sample)
- **Performance tuning** — pre-computed JSON caches, WASM pre-warming, API call limits (50/execution), response truncation (100 KB)
- **Security hardening** — sandboxed execution, no `eval` in host, fresh contexts, input validation with Zod
- Community files: CONTRIBUTING.md, CODE_OF_CONDUCT.md, SECURITY.md, issue/PR templates
- Git LFS tracking for large API spec JSON files

### Security

- **HTTP request timeout** (30s) prevents indefinite hang on slow/unreachable FortiManager
- **JSON-RPC response shape validation** prevents crashes from non-JSON-RPC responses (e.g., HTML error pages)
- **Sandbox method validation** ensures only allowed FMG methods (`get`, `set`, `add`, etc.) are forwarded
- **Sandbox params validation** verifies params is an array with required `url` field before forwarding
- **Log accumulation cap** (1 MB / 1,000 entries) prevents host OOM from runaway console.log in sandbox
- **Code input size limit** (100 KB) prevents oversized code payloads from consuming executor resources
- **SSL fallback hardened** — throws error instead of silently downgrading when undici unavailable
- **HTTP handler error boundary** — try/catch in transport prevents unhandled rejections from crashing server
- **Graceful shutdown** for both stdio and HTTP transports with signal deduplication
- **Startup health check** validates FortiManager connectivity at boot (non-fatal warning)

## [0.1.0] — 2026-03-01

Initial alpha release.

[Unreleased]: https://github.com/jmpijll/fortimanager-code-mode-mcp/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/jmpijll/fortimanager-code-mode-mcp/releases/tag/v0.1.0

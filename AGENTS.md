# Agent Guidelines for GitHub Proxy Server

This document provides coding guidelines and conventions for AI agents working on this codebase.

## Project Overview

GitHub Proxy Server is a Node.js TypeScript application that proxies GitHub API requests with automatic token management and rate limiting. It uses Express for the server, Vitest for testing, and Biome for linting/formatting.

## Build, Lint, and Test Commands

### Development
```bash
npm run dev              # Start dev server with auto-reload (tsx watch)
npm run dev-no-reload    # Start dev server without reload
```

### Build
```bash
npm run build            # Clean dist/ and build with tsup (ESM, minified, sourcemap)
npm start                # Run built CLI from dist/cli.js
```

### Testing
```bash
npm test                 # Run all tests (vitest run)
npm run test:watch       # Run tests in watch mode
npm run test:coverage    # Run tests with coverage report

# Run a single test file
npx vitest run src/cli.spec.ts

# Run tests matching a pattern
npx vitest run --grep "should create a CLI program"
```

### Linting and Formatting
```bash
npm run lint             # Check code with Biome
npm run lint:fix         # Auto-fix linting issues
npm run format           # Format code with Biome
```

### Git Hooks
Pre-commit: Runs `npm run lint` and `npm run build`
Commit-msg: Validates commit messages using commitlint (conventional commits)

### Release
```bash
npm run commit           # Interactive conventional commit (commitizen)
npm run release          # Create version tag with standard-version
npm run np               # Publish package (no-publish mode)
```

## Code Style Guidelines

### File Organization
- Source files: `src/**/*.ts`
- Test files: `src/**/*.spec.ts` (co-located with source)
- Built files: `dist/` (git-ignored)
- Entry point: `src/cli.ts`

### Import Organization
Imports must follow this order with blank lines between groups:
1. Node.js built-in modules (`:NODE:`)
2. Blank line
3. Third-party packages (`:PACKAGE:`) and aliases (`:ALIAS:`)
4. Blank line
5. Local imports

Example:
```typescript
import EventEmitter from 'node:events';
import { pathToFileURL } from 'node:url';

import chalk from 'chalk';
import { Command, Option } from 'commander';
import consola from 'consola';

import { createProxyServer } from './server.js';
```

### Import Conventions
- Use ES modules (not CommonJS)
- Use `.js` extensions in imports (TypeScript ESM requirement)
- Use `node:` protocol for Node.js built-ins (e.g., `node:fs`, `node:path`)
- JSON imports use `with { type: 'json' }` syntax
- Prefer named imports over default imports

### Formatting Rules (Biome)
- Indentation: 2 spaces
- Line width: 100 characters
- Line ending: LF
- Quotes: Single quotes for JS/TS, double quotes for JSX
- Semicolons: Always required
- Trailing commas: Never
- Arrow parentheses: Always (e.g., `(x) => x + 1`)
- Bracket spacing: Enabled (`{ foo }` not `{foo}`)

### TypeScript Guidelines
- Target: ESNext
- Module: NodeNext with NodeNext resolution
- Strict mode: Enabled
- Always use explicit types for function parameters and return values
- Avoid `any` - use `unknown` or proper types
- Use `type` for object shapes, `interface` for extendable contracts
- Enable `strict: true` and all strict type-checking options

### Naming Conventions
- Files: kebab-case (e.g., `proxy-client.ts`, `proxy-client.spec.ts`)
- Classes: PascalCase (e.g., `ProxyClient`, `ProxyWorker`)
- Functions/variables: camelCase (e.g., `createProxyServer`, `statusFormatter`)
- Constants: UPPER_SNAKE_CASE for true constants, camelCase for others
- Type aliases: PascalCase (e.g., `ProxyClientOptions`, `CliOpts`)
- Private class members: Prefix with underscore (e.g., `_queued`, `_running`)

### Error Handling
- Use typed errors with specific error codes
- Example: `const error = new Error('ETIMEDOUT') as Error & { code: string }; error.code = 'ETIMEDOUT';`
- Always handle promise rejections
- Use try-catch for async operations
- Emit errors via EventEmitter when appropriate

### Logging
- Use `consola` for CLI logging (info, success, warn, error)
- Use `pino` for HTTP request logging (when DEBUG=true)
- No `console.log` allowed (enforced by Biome: `noConsole: "error"`)
- Format data with custom formatters (see `logTransform` in server.ts)

### Testing Conventions
- Test framework: Vitest
- Test files: Co-located with source as `*.spec.ts`
- Use `describe` blocks for grouping related tests
- Use `test` or `it` for individual test cases
- Test file structure: imports → test suites → test cases
- Use `beforeEach`/`afterEach` for setup/teardown
- Mock external dependencies with `vitest.mock()` or `nock` for HTTP

### Comments
- Use JSDoc comments for public functions and classes
- Example:
```typescript
/**
 * Proxy an incoming HTTP request to the target server
 * @param req - Incoming request from Express
 * @param res - Outgoing response to Express client
 * @param options - Additional options for request modification
 */
```
- Add author attribution: `/* Author: Hudson S. Borges */` at top of new files
- Use inline comments sparingly, prefer self-documenting code

### Async/Await
- Prefer async/await over raw promises
- Always handle errors in async functions
- Use AbortController for timeout handling
- Example timeout pattern:
```typescript
const controller = new AbortController();
const timeoutId = setTimeout(() => controller.abort(), timeout);
try {
  const result = await fetch(url, { signal: controller.signal });
  clearTimeout(timeoutId);
  return result;
} catch (error) {
  clearTimeout(timeoutId);
  throw error;
}
```

## Project-Specific Patterns

### Express Router Setup
- Disable `x-powered-by` header
- Use compression middleware with configurable level
- Use basic auth for protected endpoints (exclude `/status`)
- Support express route patterns like `{/*path}` for wildcards

### Event Emitters
- Extend EventEmitter for custom classes
- Emit typed events: `log`, `warn`, `error`
- Set `defaultMaxListeners` to avoid warnings in high-concurrency scenarios

### Configuration
- Support CLI flags and environment variables
- Use `commander` for CLI parsing with `.env()` for env var binding
- Validate supported GitHub credential formats: legacy 40-character credentials, `ghp_`, `gho_`,
  `ghu_`, `ghs_`, and `ghr_` credentials with 36-character suffixes, or `github_pat_` credentials
  with an 82-character suffix

## Common Gotchas

1. Import extensions are required (`.js` not `.ts` in imports)
2. Tests exclude pattern in tsconfig: `"exclude": ["node_modules", "**/*.spec.ts"]`
3. Vitest includes tests: `include: ['src/**/*.spec.ts']`
4. Build output is ESM only (`"type": "module"` in package.json)
5. Node.js version requirement: `>=24`
6. Husky hooks will fail the commit if lint or build fail

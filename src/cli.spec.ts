import { exec, spawn } from 'node:child_process';
import { unlinkSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Command } from 'commander';
import repeat from 'lodash/repeat.js';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';

import { createAuthConfiguration, createCli, PARTIAL_AUTHENTICATION_ERROR } from './cli.js';
import {
  parseExternalBaseUrl,
  parseMaxQueueDepthPerWorker,
  parseMaxRequestBodyBytes,
  parseMinRemaining,
  parsePort,
  parseQueueWaitTimeout,
  parseRequestLifetimeTimeout,
  parseRequestTimeout,
  parseTimeBudgetMultiplier
} from './router.js';
import { concatTokens, parseTokens, readTokensFile } from './server.js';

type BooleanCliOptions = {
  overrideAuthorization: boolean;
  statusMonitor: boolean;
};

async function parseBooleanOptions(args: string[]): Promise<BooleanCliOptions> {
  const program = createCli();
  let options: BooleanCliOptions | undefined;
  program.action((parsedOptions: BooleanCliOptions) => {
    options = parsedOptions;
  });

  await program.parseAsync(['node', 'test', ...args]);

  if (!options) throw new Error('CLI options were not parsed');
  return options;
}

export type CliCmdResult = {
  code: number;
  error?: Error | null;
  stdout?: string | null;
  stderr?: string | null;
};

export async function cli(
  args: string[],
  cwd: string,
  environment: NodeJS.ProcessEnv = {}
): Promise<CliCmdResult> {
  return new Promise((resolve) => {
    exec(
      `npm run dev-no-reload -- --no-status-monitor ${args.join(' ')}`,
      { cwd, env: { ...process.env, ...environment } },
      (error, stdout, stderr) => resolve({ code: error?.code ?? 0, error, stdout, stderr })
    );
  });
}

describe('Test cli app', () => {
  test.each([
    ['max request body bytes', parseMaxRequestBodyBytes, 1024 * 1024, 16 * 1024 * 1024],
    ['max queue depth', parseMaxQueueDepthPerWorker, 1, 1000],
    ['queue wait timeout', parseQueueWaitTimeout, 1, 120000],
    ['request lifetime timeout', parseRequestLifetimeTimeout, 1, 600000]
  ])('should parse %s within its configured range', (_name, parser, min, max) => {
    expect(parser(min)).toBe(min);
    expect(parser(max)).toBe(max);
  });

  test.each([
    [parseMaxRequestBodyBytes, 1024 * 1024 - 1],
    [parseMaxQueueDepthPerWorker, 0],
    [parseQueueWaitTimeout, 0],
    [parseRequestLifetimeTimeout, 0]
  ])('should reject an invalid enhancement limit', (parser, value) => {
    expect(() => parser(value)).toThrowError();
  });

  test('it should thrown an error if token/tokens is not provided', async () => {
    const result = await cli([], '.');
    expect(result.code).toEqual(1);
  });

  test('it should thrown an error if invalid tokens are provided', async () => {
    const result = await cli(['-t', 'invalid'], '.');
    expect(result.code).toEqual(1);
  });

  test('it should reject username-only authentication before starting', async () => {
    const username = 'only-user';
    const result = await cli(['-t', '1234567890123456789012345678901234567890'], '.', {
      GPS_AUTH_USERNAME: username
    });
    const output = `${result.stdout ?? ''}${result.stderr ?? ''}`;

    expect(result.code).toEqual(1);
    expect(output).toContain(PARTIAL_AUTHENTICATION_ERROR);
    expect(output).not.toContain(username);
  });

  test('it should reject password-only authentication before starting', async () => {
    const password = 'only-password';
    const result = await cli(['-t', '1234567890123456789012345678901234567890'], '.', {
      GPS_AUTH_PASSWORD: password
    });
    const output = `${result.stdout ?? ''}${result.stderr ?? ''}`;

    expect(result.code).toEqual(1);
    expect(output).toContain(PARTIAL_AUTHENTICATION_ERROR);
    expect(output).not.toContain(password);
  });

  test('it should destroy the router when a child receives SIGTERM', async () => {
    const child = spawn(
      process.execPath,
      [
        '--import',
        'tsx/esm',
        'src/cli.ts',
        '--no-status-monitor',
        '-t',
        '1234567890123456789012345678901234567890',
        '-p',
        '0'
      ],
      { cwd: process.cwd(), env: { ...process.env, FORCE_COLOR: '0' } }
    );

    const result = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
      (resolve, reject) => {
        let settled = false;
        const timeout = setTimeout(() => {
          if (!settled) {
            child.kill('SIGKILL');
            reject(new Error('CLI did not shut down in time'));
          }
        }, 10000);
        const signalTimer = setTimeout(() => child.kill('SIGTERM'), 3000);
        child.once('error', (error) => {
          clearTimeout(timeout);
          clearTimeout(signalTimer);
          if (!settled) {
            settled = true;
            reject(error);
          }
        });
        child.once('close', (code, signal) => {
          clearTimeout(timeout);
          clearTimeout(signalTimer);
          if (!settled) {
            settled = true;
            resolve({ code, signal });
          }
        });
      }
    );

    expect(result.code).toBe(0);
    expect(result.signal).toBeNull();
  }, 15000);

  test('it should clean up when the listen server emits an error', async () => {
    const blocker = createServer();
    await new Promise<void>((resolve, reject) => {
      blocker.once('error', reject);
      blocker.listen({ host: '0.0.0.0', port: 0 }, resolve);
    });

    try {
      const address = blocker.address();
      if (!address || typeof address === 'string') throw new Error('Unable to determine test port');

      const result = await cli(
        ['-t', '1234567890123456789012345678901234567890', '-p', `${address.port}`],
        '.'
      );
      expect(result.code).toBe(1);
    } finally {
      await new Promise<void>((resolve) => blocker.close(() => resolve()));
    }
  }, 15000);
});

describe('CLI authentication configuration', () => {
  test('should leave authentication disabled when neither credential is supplied', () => {
    expect(createAuthConfiguration(undefined, undefined)).toBeUndefined();
  });

  test('should configure authentication when both credentials are supplied', () => {
    expect(createAuthConfiguration('testuser', 'testpass')).toEqual({
      username: 'testuser',
      password: 'testpass'
    });
  });

  test('should reject username-only configuration without logging the username', () => {
    const username = 'username-secret';

    expect(() => createAuthConfiguration(username, undefined)).toThrowError(
      PARTIAL_AUTHENTICATION_ERROR
    );
    expect(() => createAuthConfiguration(username, undefined)).toThrowError(
      expect.not.objectContaining({ message: expect.stringContaining(username) })
    );
  });

  test('should reject password-only configuration without logging the password', () => {
    const password = 'password-secret';

    expect(() => createAuthConfiguration(undefined, password)).toThrowError(
      PARTIAL_AUTHENTICATION_ERROR
    );
    expect(() => createAuthConfiguration(undefined, password)).toThrowError(
      expect.not.objectContaining({ message: expect.stringContaining(password) })
    );
  });
});

describe('createCli command structure', () => {
  let program: ReturnType<typeof createCli>;

  beforeEach(() => {
    program = createCli();
  });

  test('should create a CLI program', () => {
    expect(program).toBeDefined();
    expect(program).toBeInstanceOf(Command);
  });

  test('should have --port option with default value', () => {
    const portOption = program.options.find((opt) => opt.long === '--port');
    expect(portOption).toBeDefined();
    expect(portOption?.defaultValue).toBe(3000);
  });

  test('should have --token option', () => {
    const tokenOption = program.options.find((opt) => opt.long === '--token');
    expect(tokenOption).toBeDefined();
    expect(tokenOption?.defaultValue).toEqual([]);
  });

  test('should have --tokens option for file input', () => {
    const tokensOption = program.options.find((opt) => opt.long === '--tokens');
    expect(tokensOption).toBeDefined();
  });

  test('should have --request-timeout option with default', () => {
    const timeoutOption = program.options.find((opt) => opt.long === '--request-timeout');
    expect(timeoutOption).toBeDefined();
    expect(timeoutOption?.defaultValue).toBe(30000);
  });

  test('should have --min-remaining option with default', () => {
    const minRemainingOption = program.options.find((opt) => opt.long === '--min-remaining');
    expect(minRemainingOption).toBeDefined();
    expect(minRemainingOption?.defaultValue).toBe(100);
  });

  test.each([
    ['--max-request-body-bytes', 1024 * 1024],
    ['--max-queue-depth', 50],
    ['--queue-wait-timeout', 30000],
    ['--request-lifetime-timeout', 120000]
  ])('should have %s with default %s', (name, value) => {
    expect(program.options.find((option) => option.long === name)?.defaultValue).toBe(value);
  });

  test('should have --silent option', () => {
    const silentOption = program.options.find((opt) => opt.long === '--silent');
    expect(silentOption).toBeDefined();
  });

  test('should have --no-override-authorization option', () => {
    const noOverrideOption = program.options.find(
      (opt) => opt.long === '--no-override-authorization'
    );
    expect(noOverrideOption).toBeDefined();
  });

  test('should have authentication options', () => {
    const authUsernameOption = program.options.find((opt) => opt.long === '--auth-username');
    const authPasswordOption = program.options.find((opt) => opt.long === '--auth-password');

    expect(authUsernameOption).toBeDefined();
    expect(authPasswordOption).toBeDefined();
  });

  test('should have --no-status-monitor option', () => {
    const statusMonitorOption = program.options.find((opt) => opt.long === '--no-status-monitor');
    expect(statusMonitorOption).toBeDefined();
  });

  test.each([
    [[], true, true],
    [['--no-override-authorization'], false, true],
    [['--no-status-monitor'], true, false],
    [['--no-override-authorization', '--no-status-monitor'], false, false]
  ])(
    'should parse boolean defaults and explicit negative values %#',
    async (args, overrideAuthorization, statusMonitor) => {
      await expect(parseBooleanOptions(args)).resolves.toMatchObject({
        overrideAuthorization,
        statusMonitor
      });
    }
  );

  test('should have trusted external base URL option', () => {
    const externalBaseUrlOption = program.options.find((opt) => opt.long === '--external-base-url');
    expect(externalBaseUrlOption).toBeDefined();
    expect(externalBaseUrlOption?.parseArg).toBeDefined();
    expect(externalBaseUrlOption?.required).toBe(true);
  });

  test('should have version option', () => {
    const versionOption = program.options.find((opt) => opt.long === '--version');
    expect(versionOption).toBeDefined();
  });
});

describe('CLI option parsing', () => {
  let tempTokenFile: string;
  const validToken = '1234567890123456789012345678901234567890'; // 40 chars

  beforeEach(() => {
    tempTokenFile = join(tmpdir(), `test-tokens-${Date.now()}.txt`);
  });

  afterEach(() => {
    try {
      unlinkSync(tempTokenFile);
    } catch {
      // Ignore if file doesn't exist
    }
  });

  test('should have argParser for port option', () => {
    const program = createCli();
    const portOption = program.options.find((opt) => opt.long === '--port');
    expect(portOption?.parseArg).toBeDefined();
    expect(typeof portOption?.parseArg).toBe('function');
  });

  test('should have argParser for token option', () => {
    const program = createCli();
    const tokenOption = program.options.find((opt) => opt.long === '--token');
    expect(tokenOption?.parseArg).toBeDefined();
    expect(typeof tokenOption?.parseArg).toBe('function');
  });

  test('should have argParser for tokens file option', () => {
    const program = createCli();
    const tokensOption = program.options.find((opt) => opt.long === '--tokens');
    expect(tokensOption?.parseArg).toBeDefined();
    expect(typeof tokensOption?.parseArg).toBe('function');
  });

  test('should have argParser for request timeout', () => {
    const program = createCli();
    const timeoutOption = program.options.find((opt) => opt.long === '--request-timeout');
    expect(timeoutOption?.parseArg).toBeDefined();
    expect(typeof timeoutOption?.parseArg).toBe('function');
  });

  test('should have argParser for min-remaining', () => {
    const program = createCli();
    const minRemainingOption = program.options.find((opt) => opt.long === '--min-remaining');
    expect(minRemainingOption?.parseArg).toBeDefined();
    expect(typeof minRemainingOption?.parseArg).toBe('function');
  });
});

describe('Numeric configuration validation', () => {
  test.each([
    ['port', parsePort, 0, 65535],
    ['requestTimeout', parseRequestTimeout, 1, 120000],
    ['minRemaining', parseMinRemaining, 0, 5000],
    ['timeBudgetMultiplier', parseTimeBudgetMultiplier, 1, 10]
  ])('should accept %s boundaries', (_name, parse, minimum, maximum) => {
    expect(parse(minimum)).toBe(minimum);
    expect(parse(maximum)).toBe(maximum);
  });

  test.each([
    ['port', parsePort, [-1, 65536, 1.5, '1e3', '']],
    ['requestTimeout', parseRequestTimeout, [0, 120001, 1.5, 'Infinity', '']],
    ['minRemaining', parseMinRemaining, [-1, 5001, 1.5, 'NaN', '']],
    ['timeBudgetMultiplier', parseTimeBudgetMultiplier, [0, 10.1, 'Infinity', '1e2', '']]
  ])('should reject invalid %s values', (name, parse, values) => {
    for (const value of values) {
      expect(() => parse(value)).toThrow(`Invalid ${name}`);
    }
  });
});

describe('CLI environment variables', () => {
  test('should support PORT environment variable', () => {
    const program = createCli();
    const portOption = program.options.find((opt) => opt.long === '--port');
    expect(portOption?.envVar).toBe('PORT');
  });

  test('should support GPS_TOKENS_FILE environment variable', () => {
    const program = createCli();
    const tokensOption = program.options.find((opt) => opt.long === '--tokens');
    expect(tokensOption?.envVar).toBe('GPS_TOKENS_FILE');
  });

  test('should support GPS_REQUEST_TIMEOUT environment variable', () => {
    const program = createCli();
    const timeoutOption = program.options.find((opt) => opt.long === '--request-timeout');
    expect(timeoutOption?.envVar).toBe('GPS_REQUEST_TIMEOUT');
  });

  test('should support GPS_MIN_REMAINING environment variable', () => {
    const program = createCli();
    const minRemainingOption = program.options.find((opt) => opt.long === '--min-remaining');
    expect(minRemainingOption?.envVar).toBe('GPS_MIN_REMAINING');
  });

  test.each([
    ['--max-request-body-bytes', 'GPS_MAX_REQUEST_BODY_BYTES'],
    ['--max-queue-depth', 'GPS_MAX_QUEUE_DEPTH'],
    ['--queue-wait-timeout', 'GPS_QUEUE_WAIT_TIMEOUT'],
    ['--request-lifetime-timeout', 'GPS_REQUEST_LIFETIME_TIMEOUT']
  ])('should support %s environment variable %s', (name, envVar) => {
    expect(createCli().options.find((option) => option.long === name)?.envVar).toBe(envVar);
  });

  test('should support GPS_AUTH_USERNAME environment variable', () => {
    const program = createCli();
    const authUsernameOption = program.options.find((opt) => opt.long === '--auth-username');
    expect(authUsernameOption?.envVar).toBe('GPS_AUTH_USERNAME');
  });

  test('should support GPS_AUTH_PASSWORD environment variable', () => {
    const program = createCli();
    const authPasswordOption = program.options.find((opt) => opt.long === '--auth-password');
    expect(authPasswordOption?.envVar).toBe('GPS_AUTH_PASSWORD');
  });

  test('should support GPS_EXTERNAL_BASE_URL environment variable', () => {
    const program = createCli();
    const externalBaseUrlOption = program.options.find((opt) => opt.long === '--external-base-url');
    expect(externalBaseUrlOption?.envVar).toBe('GPS_EXTERNAL_BASE_URL');
  });
});

describe('External base URL validation', () => {
  test('should accept and normalize absolute HTTP(S) URLs', () => {
    expect(parseExternalBaseUrl('http://proxy.example/base/')).toBe('http://proxy.example/base');
    expect(parseExternalBaseUrl('https://proxy.example')).toBe('https://proxy.example');
    expect(parseExternalBaseUrl(undefined)).toBeUndefined();
  });

  test.each(['ftp://proxy.example', '//proxy.example', 'not-a-url', 'https://proxy.example/?x=1'])(
    'should reject invalid external base URL %s',
    (value) => {
      expect(() => parseExternalBaseUrl(value)).toThrow('Invalid externalBaseUrl');
    }
  );
});

describe('Helper Functions - concatTokens', () => {
  test('should add valid token to empty list', () => {
    const token = '1234567890123456789012345678901234567890';
    const result = concatTokens(token, []);
    expect(result).toContain(token);
    expect(result).toHaveLength(1);
  });

  test('should accept supported prefixed GitHub credential formats', () => {
    const credentials = [
      `ghp_${repeat('a', 36)}`,
      `gho_${repeat('b', 36)}`,
      `ghu_${repeat('c', 36)}`,
      `ghs_${repeat('d', 36)}`,
      `ghr_${repeat('e', 36)}`,
      `github_pat_${repeat('f', 82)}`
    ];

    expect(
      credentials.reduce<string[]>((list, credential) => concatTokens(credential, list), [])
    ).toEqual(credentials);
  });

  test('should add valid token to existing list', () => {
    const token1 = '1234567890123456789012345678901234567890';
    const token2 = '0987654321098765432109876543210987654321';
    const result = concatTokens(token2, [token1]);
    expect(result).toContain(token1);
    expect(result).toContain(token2);
    expect(result).toHaveLength(2);
  });

  test('should not duplicate tokens', () => {
    const token = '1234567890123456789012345678901234567890';
    const result = concatTokens(token, [token]);
    expect(result).toHaveLength(1);
  });

  test('should throw error for token with less than 40 characters', () => {
    const invalidToken = '123456789012345678901234567890123456789'; // 39 chars
    expect(() => concatTokens(invalidToken, [])).toThrow('Invalid access token detected');
  });

  test('should throw error for token with more than 40 characters', () => {
    const invalidToken = '12345678901234567890123456789012345678901'; // 41 chars
    expect(() => concatTokens(invalidToken, [])).toThrow('Invalid access token detected');
  });

  test('should throw error for empty token', () => {
    expect(() => concatTokens('', [])).toThrow('Invalid access token detected');
  });

  test('should reject unsupported credential formats without exposing them', () => {
    const invalidToken = `github_pat_${repeat('secret', 20)}`;

    expect(() => concatTokens(invalidToken, [])).toThrow(
      expect.not.objectContaining({ message: expect.stringContaining(invalidToken) })
    );
  });
});

describe('Helper Functions - parseTokens', () => {
  test('should parse single token from text', () => {
    const token = '1234567890123456789012345678901234567890';
    const result = parseTokens(token);
    expect(result).toContain(token);
    expect(result).toHaveLength(1);
  });

  test('should parse multiple tokens separated by newlines', () => {
    const token1 = '1234567890123456789012345678901234567890';
    const token2 = '0987654321098765432109876543210987654321';
    const text = `${token1}\n${token2}`;
    const result = parseTokens(text);
    expect(result).toContain(token1);
    expect(result).toContain(token2);
    expect(result).toHaveLength(2);
  });

  test('should ignore lines starting with //', () => {
    const token = '1234567890123456789012345678901234567890';
    const text = `// This is a comment\n${token}`;
    const result = parseTokens(text);
    expect(result).toContain(token);
    expect(result).toHaveLength(1);
  });

  test('should ignore lines starting with #', () => {
    const token = '1234567890123456789012345678901234567890';
    const text = `# This is a comment\n${token}`;
    const result = parseTokens(text);
    expect(result).toContain(token);
    expect(result).toHaveLength(1);
  });

  test('should handle empty lines', () => {
    const token = '1234567890123456789012345678901234567890';
    const text = `${token}\n\n`;
    const result = parseTokens(text);
    expect(result).toContain(token);
    expect(result).toHaveLength(1);
  });

  test('should extract token from key:value format', () => {
    const token = '1234567890123456789012345678901234567890';
    const text = `github_token:${token}`;
    const result = parseTokens(text);
    expect(result).toContain(token);
    expect(result).toHaveLength(1);
  });

  test('should remove whitespace from tokens', () => {
    const token = '1234567890123456789012345678901234567890';
    const text = `  ${token}  `;
    const result = parseTokens(text);
    expect(result).toContain(token);
  });

  test('should handle mixed format with comments and tokens', () => {
    const token1 = '1234567890123456789012345678901234567890';
    const token2 = '0987654321098765432109876543210987654321';
    const text = `# GitHub tokens\n${token1}\n// Another token\ntoken:${token2}`;
    const result = parseTokens(text);
    expect(result).toContain(token1);
    expect(result).toContain(token2);
    expect(result).toHaveLength(2);
  });

  test('should return empty array for text with only comments', () => {
    const text = '// Comment 1\n# Comment 2';
    const result = parseTokens(text);
    expect(result).toHaveLength(0);
  });
});

describe('Helper Functions - readTokensFile', () => {
  let tempTokenFile: string;

  beforeEach(() => {
    tempTokenFile = join(tmpdir(), `test-tokens-${Date.now()}.txt`);
  });

  afterEach(() => {
    try {
      unlinkSync(tempTokenFile);
    } catch {
      // Ignore if file doesn't exist
    }
  });

  test('should read tokens from file', () => {
    const token1 = '1234567890123456789012345678901234567890';
    const token2 = '0987654321098765432109876543210987654321';
    writeFileSync(tempTokenFile, `${token1}\n${token2}`);

    const result = readTokensFile(tempTokenFile);
    expect(result).toContain(token1);
    expect(result).toContain(token2);
    expect(result).toHaveLength(2);
  });

  test('should throw error if file does not exist', () => {
    expect(() => readTokensFile('non-existent-file.txt')).toThrow('not found');
  });

  test('should read tokens from file with comments', () => {
    const token = '1234567890123456789012345678901234567890';
    writeFileSync(tempTokenFile, `# This is a comment\n${token}\n// Another comment`);

    const result = readTokensFile(tempTokenFile);
    expect(result).toContain(token);
    expect(result).toHaveLength(1);
  });

  test('should handle file with key:value format', () => {
    const token = '1234567890123456789012345678901234567890';
    writeFileSync(tempTokenFile, `github_token:${token}`);

    const result = readTokensFile(tempTokenFile);
    expect(result).toContain(token);
    expect(result).toHaveLength(1);
  });

  test('should handle empty file', () => {
    writeFileSync(tempTokenFile, '');

    const result = readTokensFile(tempTokenFile);
    expect(result).toHaveLength(0);
  });
});

describe('CLI flag combinations', () => {
  test('should have optional port parameter', () => {
    const program = createCli();
    const portOption = program.options.find((opt) => opt.long === '--port');
    expect(portOption?.optional).toBe(true);
  });

  test('should have required min-remaining parameter', () => {
    const program = createCli();
    const minRemainingOption = program.options.find((opt) => opt.long === '--min-remaining');
    expect(minRemainingOption?.required).toBe(true);
  });

  test('should have correct short flag for port', () => {
    const program = createCli();
    const portOption = program.options.find((opt) => opt.long === '--port');
    expect(portOption?.short).toBe('-p');
  });

  test('should have correct short flag for token', () => {
    const program = createCli();
    const tokenOption = program.options.find((opt) => opt.long === '--token');
    expect(tokenOption?.short).toBe('-t');
  });

  test('should have correct short flag for version', () => {
    const program = createCli();
    const versionOption = program.options.find((opt) => opt.long === '--version');
    expect(versionOption?.short).toBe('-v');
  });
});
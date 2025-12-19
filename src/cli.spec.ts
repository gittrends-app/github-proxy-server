import { exec } from 'node:child_process';
import { unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Command } from 'commander';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';

import { createCli } from './cli.js';
import { concatTokens, parseTokens, readTokensFile } from './server.js';

export type CliCmdResult = {
  code: number;
  error?: Error | null;
  stdout?: string | null;
  stderr?: string | null;
};

export async function cli(args: string[], cwd: string): Promise<CliCmdResult> {
  return new Promise((resolve) => {
    exec(
      `npm run dev-no-reload --no-status-monitor ${args.join(' ')}`,
      { cwd },
      (error, stdout, stderr) => resolve({ code: error?.code ?? 0, error, stdout, stderr })
    );
  });
}

describe('Test cli app', () => {
  test('it should thrown an error if token/tokens is not provided', async () => {
    const result = await cli([], '.');
    expect(result.code).toEqual(1);
  });

  test('it should thrown an error if invalid tokens are provided', async () => {
    const result = await cli(['-t', 'invalid'], '.');
    expect(result.code).toEqual(1);
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

  test('should have clustering options', () => {
    const clusteringOption = program.options.find((opt) => opt.long === '--clustering');
    const clusteringHostOption = program.options.find((opt) => opt.long === '--clustering-host');
    const clusteringPortOption = program.options.find((opt) => opt.long === '--clustering-port');
    const clusteringDbOption = program.options.find((opt) => opt.long === '--clustering-db');

    expect(clusteringOption).toBeDefined();
    expect(clusteringHostOption).toBeDefined();
    expect(clusteringPortOption).toBeDefined();
    expect(clusteringDbOption).toBeDefined();

    expect(clusteringHostOption?.defaultValue).toBe('localhost');
    expect(clusteringPortOption?.defaultValue).toBe(6379);
    expect(clusteringDbOption?.defaultValue).toBe(0);
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

  test('should have argParser for clustering port', () => {
    const program = createCli();
    const clusteringPortOption = program.options.find((opt) => opt.long === '--clustering-port');
    expect(clusteringPortOption?.parseArg).toBeDefined();
    expect(typeof clusteringPortOption?.parseArg).toBe('function');
  });

  test('should have argParser for clustering db', () => {
    const program = createCli();
    const clusteringDbOption = program.options.find((opt) => opt.long === '--clustering-db');
    expect(clusteringDbOption?.parseArg).toBeDefined();
    expect(typeof clusteringDbOption?.parseArg).toBe('function');
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

  test('should support GPS_CLUSTERING_HOST environment variable', () => {
    const program = createCli();
    const clusteringHostOption = program.options.find((opt) => opt.long === '--clustering-host');
    expect(clusteringHostOption?.envVar).toBe('GPS_CLUSTERING_HOST');
  });

  test('should support GPS_CLUSTERING_PORT environment variable', () => {
    const program = createCli();
    const clusteringPortOption = program.options.find((opt) => opt.long === '--clustering-port');
    expect(clusteringPortOption?.envVar).toBe('GPS_CLUSTERING_PORT');
  });

  test('should support GPS_CLUSTERING_DB environment variable', () => {
    const program = createCli();
    const clusteringDbOption = program.options.find((opt) => opt.long === '--clustering-db');
    expect(clusteringDbOption?.envVar).toBe('GPS_CLUSTERING_DB');
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
});

describe('Helper Functions - concatTokens', () => {
  test('should add valid token to empty list', () => {
    const token = '1234567890123456789012345678901234567890';
    const result = concatTokens(token, []);
    expect(result).toContain(token);
    expect(result).toHaveLength(1);
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

  test('should have clustering option disabled by default', () => {
    const program = createCli();
    const clusteringOption = program.options.find((opt) => opt.long === '--clustering');
    expect(clusteringOption?.defaultValue).toBe(false);
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

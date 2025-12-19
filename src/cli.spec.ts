import { exec } from 'node:child_process';

import { describe, expect, test } from '@jest/globals';

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

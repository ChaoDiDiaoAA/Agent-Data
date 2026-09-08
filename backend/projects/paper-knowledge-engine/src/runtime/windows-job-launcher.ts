interface LaunchRequest {
  stdinText?: string;
}

function fail(message: string): never {
  throw new Error(`WINDOWS_JOB_LAUNCHER_ERROR: ${message}`);
}

export async function runWindowsJobLauncher(command: string[]): Promise<number> {
  try {
    if (!command.length) fail('missing target command');
    let request: LaunchRequest;
    try {
      const value: unknown = JSON.parse(await Bun.stdin.text());
      if (!value || typeof value !== 'object') fail('invalid launch request');
      const stdinText = Reflect.get(value, 'stdinText');
      if (stdinText !== undefined && typeof stdinText !== 'string') fail('invalid stdin payload');
      request = stdinText === undefined ? {} : { stdinText };
    } catch {
      fail('invalid launch request');
    }

    const child = Bun.spawn(command, {
      cwd: process.cwd(),
      env: process.env,
      stdin: request.stdinText === undefined ? 'ignore' : 'pipe',
      stdout: 'inherit',
      stderr: 'inherit',
      windowsHide: true,
    });
    if (request.stdinText !== undefined) {
      try {
        const input = child.stdin as Bun.FileSink;
        input.write(request.stdinText);
        await input.flush();
        await input.end();
      } catch {
        child.kill();
        fail('target stdin failed');
      }
    }
    return await child.exited;
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    return 125;
  }
}

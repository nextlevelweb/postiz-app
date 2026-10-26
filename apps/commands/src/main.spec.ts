// The operator command entry point: run the command, close Nest, and leave
// with the exit code the command set. The Redis client and the Temporal
// worker connection stay open after close(), so without the exit a finished
// command never ends where Redis or Temporal can be reached
const app = {
  select: jest.fn(),
  get: jest.fn(),
  exec: jest.fn(),
  close: jest.fn(),
};
const calls: string[] = [];
jest.mock('@nestjs/core', () => ({
  NestFactory: { createApplicationContext: jest.fn(async () => app) },
}));
jest.mock('./command.module', () => ({ CommandModule: class {} }));
jest.mock('nestjs-command', () => ({ CommandService: class {} }));

const runMain = async () => {
  jest.isolateModules(() => {
    require('./main');
  });
  // bootstrap() is not awaited by main.ts: wait for its exit
  for (let i = 0; i < 400 && !calls.some((c) => c.startsWith('exit')); i++) {
    await new Promise((r) => setTimeout(r, 5));
  }
};

describe('apps/commands main', () => {
  let exit: jest.SpyInstance;
  let error: jest.SpyInstance;
  beforeEach(() => {
    calls.length = 0;
    app.select.mockImplementation(() => app);
    app.get.mockImplementation(() => app);
    app.close.mockImplementation(async () => {
      calls.push('close');
    });
    exit = jest.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      calls.push(`exit(${code ?? ''})`);
    }) as never);
    error = jest.spyOn(console, 'error').mockImplementation(() => undefined);
  });
  afterEach(() => {
    process.exitCode = undefined;
  });

  it('CMD1 a finished command closes Nest, then exits with the code it set', async () => {
    app.exec.mockImplementation(async () => {
      calls.push('exec');
      process.exitCode = 1;
    });
    await runMain();
    expect(calls).toEqual(['exec', 'close', 'exit()']);
    // no argument: process.exit() keeps process.exitCode (1 here, 0 unset)
    expect(exit).toHaveBeenCalledWith();
    expect(process.exitCode).toBe(1);
  });

  it('CMD3 what providers print while starting goes to stderr; what the command prints, to stdout (P8-R1B)', async () => {
    const { NestFactory } = jest.requireMock('@nestjs/core');
    NestFactory.createApplicationContext.mockImplementationOnce(async () => {
      console.log('Email service provider: no provider');
      return app;
    });
    const log = jest.spyOn(console, 'log').mockImplementation(() => undefined);
    app.exec.mockImplementation(async () => {
      calls.push('exec');
      console.log('{"report":true}');
    });
    await runMain();
    expect(error).toHaveBeenCalledWith('Email service provider: no provider');
    expect(log.mock.calls).toEqual([['{"report":true}']]);
    expect(calls).toEqual(['exec', 'close', 'exit()']);
    log.mockRestore();
  });

  it('CMD2 a command that throws closes Nest and exits 1', async () => {
    app.exec.mockImplementation(async () => {
      calls.push('exec');
      throw new Error('boom');
    });
    await runMain();
    expect(calls).toEqual(['exec', 'close', 'exit(1)']);
    expect(error).toHaveBeenCalled();
  });
});

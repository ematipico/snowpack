import detectPort from 'detect-port';
import {EventEmitter} from 'events';
import * as colors from 'kleur/colors';
import readline from 'readline';
import util from 'util';
import {BuildScript} from '../config';
import {isYarn} from '../util';
const cwd = process.cwd();

/**
 * Get the actual port, based on the `defaultPort`.
 * If the default port was not available, then we'll prompt the user if its okay
 * to use the next available port.
 */
export async function getPort(defaultPort: number): Promise<number> {
  const bestAvailablePort = await detectPort(defaultPort);
  if (defaultPort !== bestAvailablePort) {
    let useNextPort: boolean = false;
    if (process.stdout.isTTY) {
      const rl = readline.createInterface({input: process.stdin, output: process.stdout});
      useNextPort = await new Promise((resolve) => {
        rl.question(
          colors.yellow(
            `! Port ${colors.bold(defaultPort)} not available. Run on port ${colors.bold(
              bestAvailablePort,
            )} instead? (Y/n) `,
          ),
          (answer) => {
            resolve(!/^no?$/i.test(answer));
          },
        );
      });
      rl.close();
    }
    if (!useNextPort) {
      console.error(
        colors.red(
          `✘ Port ${colors.bold(defaultPort)} not available. Use ${colors.bold(
            '--port',
          )} to specify a different port.`,
        ),
      );
      console.error();
      process.exit(1);
    }
  }
  return bestAvailablePort;
}

function getStateString(workerState: any, isWatch: boolean): [colors.Colorize, string] {
  if (workerState.state) {
    if (Array.isArray(workerState.state)) {
      return [colors[workerState.state[1]], workerState.state[0]];
    }
    return [colors.dim, workerState.state];
  }
  if (workerState.done) {
    return workerState.error ? [colors.red, 'FAIL'] : [colors.green, 'DONE'];
  }
  if (isWatch) {
    if (workerState.config.watch) {
      return [colors.dim, 'WATCH'];
    }
  }
  return [colors.dim, 'READY'];
}

const WORKER_BASE_STATE = {done: false, error: null, output: ''};

export function paint(
  bus: EventEmitter,
  registeredWorkers: BuildScript[],
  buildMode: {dest: string} | undefined,
  devMode:
    | {
        addPackage: (pkgName: string) => void;
      }
    | undefined,
) {
  let port: number;
  let protocol = '';
  let startTimeMs: number;
  let ips: string[] = [];
  let consoleOutput = '';
  let installOutput = '';
  let isInstalling = false;
  let hasBeenCleared = false;
  let missingWebModule: null | {id: string; spec: string; pkgName: string} = null;
  const allWorkerStates: any = {};

  for (const config of registeredWorkers) {
    allWorkerStates[config.id] = {...WORKER_BASE_STATE, config};
  }

  function repaint() {
    process.stdout.write(process.platform === 'win32' ? '\x1B[2J\x1B[0f' : '\x1B[2J\x1B[3J\x1B[H');
    process.stdout.write(`${colors.bold('Snowpack')}\n\n`);
    // Dashboard
    if (devMode) {
      const isServerStarted = startTimeMs > 0 && port > 0 && protocol;
      if (isServerStarted) {
        process.stdout.write(`  ${colors.bold(colors.cyan(`${protocol}//localhost:${port}`))}`);
        for (const ip of ips) {
          process.stdout.write(
            `${colors.cyan(` > `)}${colors.bold(colors.cyan(`${protocol}//${ip}:${port}`))}`,
          );
        }
        process.stdout.write('\n');
        process.stdout.write(
          colors.dim(
            startTimeMs < 1000 ? `  Server started in ${startTimeMs}ms.` : `  Server started.`, // Not to hide slow startup times, but likely there were extraneous factors (prompts, etc.) where the speed isn’t accurate
          ),
        );
        process.stdout.write('\n\n');
      } else {
        process.stdout.write(colors.dim(`  Server starting…`) + '\n\n');
      }
    }
    if (buildMode) {
      process.stdout.write('  ' + colors.bold(colors.cyan(buildMode.dest)));
      process.stdout.write(colors.dim(` Building your application...\n\n`));
    }

    for (const config of registeredWorkers) {
      if (devMode && config.type === 'bundle') {
        continue;
      }
      const workerState = allWorkerStates[config.id];
      const dotLength = 24 - config.id.length;
      const dots = colors.dim(''.padEnd(dotLength, '.'));
      const [fmt, stateString] = getStateString(workerState, !!devMode);
      const spacer = ' '; //.padEnd(8 - stateString.length);
      let cmdMsg = `${config.plugin && config.cmd[0] !== '(' ? '(plugin) ' : ''}${config.cmd}`;
      if (cmdMsg.length > 52) {
        cmdMsg = cmdMsg.substr(0, 52) + '...';
      }
      const cmdStr = stateString === 'FAIL' ? colors.red(cmdMsg) : colors.dim(cmdMsg);
      process.stdout.write(`  ${config.id}${dots}[${fmt(stateString)}]${spacer}${cmdStr}\n`);
    }
    process.stdout.write('\n');
    if (isInstalling) {
      process.stdout.write(`${colors.underline(colors.bold('▼ snowpack install'))}\n\n`);
      process.stdout.write('  ' + installOutput.trim().replace(/\n/gm, '\n  '));
      process.stdout.write('\n\n');
      return;
    }
    if (missingWebModule) {
      const {id, pkgName, spec} = missingWebModule;
      process.stdout.write(`${colors.red(colors.underline(colors.bold('▼ Snowpack')))}\n\n`);
      if (devMode) {
        process.stdout.write(`  Package ${colors.bold(pkgName)} not found!\n`);
        process.stdout.write(colors.dim(`  in ${id}`));
        process.stdout.write(`\n\n`);
        process.stdout.write(
          `  ${colors.bold('Press Enter')} to automatically run ${colors.bold(
            isYarn(cwd) ? `yarn add ${pkgName}` : `npm install --save ${pkgName}`,
          )}.\n`,
        );
        process.stdout.write(`  Or, Exit Snowpack and install manually to continue.\n`);
      } else {
        process.stdout.write(`  Dependency ${colors.bold(spec)} not found!\n\n`);
        // process.stdout.write(
        //   `  Run ${colors.bold('snowpack install')} to install all required dependencies.\n\n`,
        // );
        process.exit(1);
      }
      return;
    }
    for (const config of registeredWorkers) {
      const workerState = allWorkerStates[config.id];
      if (workerState && workerState.output) {
        const colorsFn = Array.isArray(workerState.error) ? colors.red : colors.reset;
        process.stdout.write(`${colorsFn(colors.underline(colors.bold('▼ ' + config.id)))}\n\n`);
        process.stdout.write(
          workerState.output
            ? '  ' + workerState.output.trim().replace(/\n/gm, '\n  ')
            : hasBeenCleared
            ? colors.dim('  Output cleared.')
            : colors.dim('  No output, yet.'),
        );
        process.stdout.write('\n\n');
      }
    }
    if (consoleOutput) {
      process.stdout.write(`${colors.underline(colors.bold('▼ Console'))}\n\n`);
      process.stdout.write(
        consoleOutput
          ? '  ' + consoleOutput.trim().replace(/\n/gm, '\n  ')
          : hasBeenCleared
          ? colors.dim('  Output cleared.')
          : colors.dim('  No output, yet.'),
      );
      process.stdout.write('\n\n');
    }
    const overallStatus: any = Object.values(allWorkerStates).reduce(
      (result: any, {done, error}: any) => {
        return {
          done: result.done && done,
          error: result.error || error,
        };
      },
    );
    if (overallStatus.error) {
      process.stdout.write(`${colors.underline(colors.red(colors.bold('▼ Result')))}\n\n`);
      process.stdout.write('  ⚠️  Finished, with errors.');
      process.stdout.write('\n\n');
      process.exit(1);
    } else if (overallStatus.done) {
      process.stdout.write(
        `${colors.underline(colors.green(colors.bold('▶ Build Complete!')))}\n\n`,
      );
    }
  }

  bus.on('WORKER_MSG', ({id, msg}) => {
    allWorkerStates[id].output += msg;
    repaint();
  });
  bus.on('WORKER_UPDATE', ({id, state}) => {
    if (typeof state !== undefined) {
      allWorkerStates[id].state = state;
    }
    repaint();
  });
  bus.on('WORKER_COMPLETE', ({id, error}) => {
    allWorkerStates[id].state = null;
    allWorkerStates[id].done = true;
    allWorkerStates[id].error = allWorkerStates[id].error || error;
    repaint();
  });
  bus.on('WORKER_RESET', ({id}) => {
    allWorkerStates[id] = {...WORKER_BASE_STATE, config: allWorkerStates[id].config};
    repaint();
  });
  bus.on('CONSOLE', ({level, args}) => {
    if (isInstalling) {
      const msg = util.format.apply(util, args);
      if (!msg.startsWith('[404] ')) {
        installOutput += msg;
      }
    } else {
      consoleOutput += `[${level}] ${util.format.apply(util, args)}\n`;
    }
    repaint();
  });
  bus.on('NEW_SESSION', () => {
    if (consoleOutput) {
      consoleOutput = ``;
      hasBeenCleared = true;
    }
    // Reset all per-file build scripts
    for (const config of registeredWorkers) {
      if (config.type === 'build') {
        allWorkerStates[config.id] = {
          ...WORKER_BASE_STATE,
          config: allWorkerStates[config.id].config,
        };
      }
    }
    repaint();
  });
  bus.on('INSTALLING', () => {
    isInstalling = true;
    installOutput = '';
    repaint();
  });
  bus.on('INSTALL_COMPLETE', () => {
    setTimeout(() => {
      missingWebModule = null;
      isInstalling = false;
      installOutput = '';
      consoleOutput = ``;
      hasBeenCleared = true;
      repaint();
    }, 2000);
  });
  bus.on('MISSING_WEB_MODULE', ({id, data}) => {
    if (!missingWebModule && data) {
      missingWebModule = {id, ...data};
    }
    if (missingWebModule && missingWebModule.id === id) {
      if (!data) {
        missingWebModule = null;
      } else {
        missingWebModule = {id, ...data};
      }
    }
    repaint();
  });
  bus.on('SERVER_START', (info) => {
    startTimeMs = info.startTimeMs;
    port = info.port;
    protocol = info.protocol;
    ips = info.ips;
    repaint();
  });

  if (devMode) {
    readline.emitKeypressEvents(process.stdin);
    process.stdin.on('keypress', (str, key) => {
      if (key.name !== 'return' && key.name !== 'enter') {
        return;
      }
      if (!missingWebModule) {
        return;
      }
      devMode.addPackage(missingWebModule.pkgName);
      repaint();
    });
  }

  repaint();
}

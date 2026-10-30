import spawn from 'cross-spawn';

// Same call shape as execFileSync. cross-spawn also finds the sokosumi.cmd shim npm installs on Windows.
export function runCommand(command, args, options = {}) {
  const result = spawn.sync(command, args, {encoding: 'utf8', ...options});
  if (result.error) throw result.error;
  if (result.status !== 0) {
    const stderr = String(result.stderr ?? '').slice(0, 200);
    throw new Error(`${command} ${args[0] ?? ''} exited with code ${result.status}: ${stderr}`);
  }
  return result.stdout;
}

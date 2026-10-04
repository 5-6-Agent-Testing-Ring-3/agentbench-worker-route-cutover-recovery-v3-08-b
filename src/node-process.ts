/**
 * `@cloudflare/workers-types` declares a global `process: any`, which would
 * make every use of the Node process object untyped in this project. Narrow it
 * once here so the CLI and the lock keep real types.
 */
export interface NodeProcess {
  readonly argv: readonly string[];
  exitCode: number | undefined;
  readonly pid: number;
  readonly stdout: { write(text: string): boolean };
  readonly stderr: { write(text: string): boolean };
  kill(pid: number, signal: number): boolean;
}

export const nodeProcess = (globalThis as { process?: unknown })
  .process as NodeProcess;

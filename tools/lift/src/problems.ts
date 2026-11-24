// SPDX-License-Identifier: GPL-3.0-or-later
/** Everything wrong with a lift: errors fail the run, warnings go in the coverage report. */
export class Problems {
  readonly errors: string[] = [];
  readonly warnings: string[] = [];

  error(where: string, message: string): void {
    this.errors.push(`${where}: ${message}`);
  }

  warn(where: string, message: string): void {
    this.warnings.push(`${where}: ${message}`);
  }
}

export class LiftError extends Error {
  constructor(readonly problems: string[]) {
    super(`the lift has ${problems.length} problem(s):\n${problems.join('\n')}`);
    this.name = 'LiftError';
  }
}

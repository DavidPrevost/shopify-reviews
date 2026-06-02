// Tiny assertion + reporting harness for the internal test suite.
//
// Design goals:
//  - Every failure carries (a) a clear message, (b) the actual + expected values
//    or structured context, (c) the assertion that fired. So when something
//    fails, the report says exactly what reality looked like, not just "AssertionError".
//  - Each test file owns a TestRun. The orchestrator collects all the per-file
//    summaries and exits with code 1 on any failure.

export interface FailureRecord {
  testName: string;
  message: string;
  context?: Record<string, unknown>;
  stack?: string;
}

export class TestRun {
  private fails: FailureRecord[] = [];
  private passes = 0;
  private skips: Array<{ name: string; reason: string }> = [];
  private inFlight = false;

  constructor(public suiteName: string) {
    console.log(`\n=== ${suiteName} ===`);
  }

  async test(name: string, fn: () => void | Promise<void>): Promise<void> {
    if (this.inFlight) {
      throw new Error(`test() called recursively — fix: don't await tests inside tests (got nested: ${name})`);
    }
    this.inFlight = true;
    try {
      await fn();
      this.passes++;
      console.log(`  PASS  ${name}`);
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      const context = e instanceof AssertionError ? e.context : undefined;
      const stack = e instanceof Error ? (e.stack ?? undefined) : undefined;
      this.fails.push({ testName: name, message, context, stack });
      console.error(`  FAIL  ${name}`);
      console.error(`        ${message}`);
      if (context && Object.keys(context).length > 0) {
        for (const [k, v] of Object.entries(context)) {
          const pretty = typeof v === 'object' ? JSON.stringify(v, null, 2).split('\n').join('\n        ') : String(v);
          console.error(`        ${k}: ${pretty}`);
        }
      }
      // Print just the first few stack frames (skip the harness ones) so we can
      // see where the assertion came from without drowning in node internals.
      if (stack && process.env.SHOW_STACK === '1') {
        const lines = stack.split('\n').slice(1, 6);
        for (const line of lines) console.error(`        ${line}`);
      }
    } finally {
      this.inFlight = false;
    }
  }

  skip(name: string, reason: string): void {
    this.skips.push({ name, reason });
    console.log(`  SKIP  ${name}  -- ${reason}`);
  }

  // Call at the end of each test file. Returns true iff all tests passed.
  finish(): boolean {
    const failed = this.fails.length;
    const skipped = this.skips.length;
    const summary = `${this.suiteName}: ${this.passes} passed, ${failed} failed, ${skipped} skipped`;
    if (failed > 0) {
      console.error(`\n${summary}`);
    } else {
      console.log(`\n${summary}`);
    }
    return failed === 0;
  }

  failures(): readonly FailureRecord[] { return this.fails; }
  passCount(): number { return this.passes; }
  skipCount(): number { return this.skips.length; }
}

export class AssertionError extends Error {
  public context?: Record<string, unknown>;
  constructor(message: string, context?: Record<string, unknown>) {
    super(message);
    this.name = 'AssertionError';
    this.context = context;
  }
}

export function assert(condition: unknown, message: string, context?: Record<string, unknown>): asserts condition {
  if (!condition) throw new AssertionError(message, context);
}

export function assertEqual<T>(actual: T, expected: T, message: string, extraContext: Record<string, unknown> = {}): void {
  if (actual !== expected) {
    throw new AssertionError(message, { actual, expected, ...extraContext });
  }
}

export function assertDeepEqual(actual: unknown, expected: unknown, message: string): void {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  if (a !== b) {
    throw new AssertionError(message, { actual, expected });
  }
}

export function assertIncludes(haystack: string, needle: string, message: string): void {
  if (!haystack.includes(needle)) {
    throw new AssertionError(message, { needle, haystack: haystack.slice(0, 500) });
  }
}

export function assertMatch(actual: string, pattern: RegExp, message: string): void {
  if (!pattern.test(actual)) {
    throw new AssertionError(message, { pattern: pattern.toString(), actual });
  }
}

export function assertThrows(fn: () => unknown, predicate: (e: unknown) => boolean, message: string): void {
  let threw = false;
  let caught: unknown;
  try {
    fn();
  } catch (e) {
    threw = true;
    caught = e;
  }
  if (!threw) {
    throw new AssertionError(`${message} — expected function to throw, but it returned normally`);
  }
  if (!predicate(caught)) {
    throw new AssertionError(`${message} — function threw, but predicate failed`, {
      caught: caught instanceof Error ? caught.message : String(caught),
    });
  }
}

// Run a test file as a child process and capture pass/fail. Used by run-all.ts.
export interface SuiteResult {
  suite: string;
  passed: boolean;
  exitCode: number;
  stdout: string;
  stderr: string;
  durationMs: number;
}

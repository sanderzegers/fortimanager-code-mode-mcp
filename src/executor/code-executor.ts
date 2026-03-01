/**
 * Code Executor — Run code that calls the live FortiManager API
 *
 * Injects a `fortimanager` global with a `request()` method that proxies
 * JSON-RPC calls from the sandbox to the host FMG client.
 *
 * Uses the async variant of QuickJS so sandbox code can `await` API calls.
 */

import {
  newAsyncContext,
  shouldInterruptAfterDeadline,
  type QuickJSAsyncContext,
  type QuickJSHandle,
} from 'quickjs-emscripten';
import type { FmgClient } from '../client/fmg-client.js';
import type { FmgMethod, FmgRequestParams } from '../client/types.js';
import {
  DEFAULT_EXECUTOR_OPTIONS,
  type ExecuteResult,
  type ExecutorOptions,
  type LogEntry,
} from './types.js';

// ─── Constants ──────────────────────────────────────────────────────

/** Maximum number of API calls per single execute() invocation */
const MAX_API_CALLS_PER_EXECUTION = 50;

// ─── Code Executor ──────────────────────────────────────────────────

export class CodeExecutor {
  private readonly client: FmgClient;
  private readonly options: Required<ExecutorOptions>;

  constructor(client: FmgClient, options?: ExecutorOptions) {
    this.client = client;
    this.options = { ...DEFAULT_EXECUTOR_OPTIONS, ...options };
  }

  /**
   * Execute JavaScript code that can call the FortiManager API.
   *
   * Inside the sandbox, `fortimanager.request(method, params)` is available.
   * It takes a JSON-RPC method and params array, proxies the call to the
   * host FMG client, and returns the response.
   */
  async execute(code: string): Promise<ExecuteResult> {
    const startTime = Date.now();
    const logs: LogEntry[] = [];

    // Create an isolated async context (separate WASM module)
    const context = await newAsyncContext();
    const runtime = context.runtime;

    try {
      // Configure resource limits
      runtime.setMemoryLimit(this.options.maxMemoryBytes);
      runtime.setMaxStackSize(512 * 1024);
      runtime.setInterruptHandler(
        shouldInterruptAfterDeadline(Date.now() + this.options.timeoutMs),
      );

      // Wire up console
      this.setupConsole(context, logs);

      // Inject fortimanager.request() proxy
      this.setupFortiManagerProxy(context);

      // Evaluate the code (async — supports await)
      const result = await context.evalCodeAsync(code, 'sandbox.js', { type: 'global' });

      if (result.error) {
        const errorValue: unknown = context.dump(result.error);
        result.error.dispose();

        return {
          ok: false,
          error: formatError(errorValue),
          logs,
          durationMs: Date.now() - startTime,
        };
      }

      const value: unknown = context.dump(result.value);
      result.value.dispose();

      return {
        ok: true,
        data: value,
        logs,
        durationMs: Date.now() - startTime,
      };
    } catch (err: unknown) {
      return {
        ok: false,
        error: err instanceof Error ? err.message : String(err),
        logs,
        durationMs: Date.now() - startTime,
      };
    } finally {
      context.dispose();
      runtime.dispose();
    }
  }

  // ── Console Capture ─────────────────────────────────────────────

  private setupConsole(context: QuickJSAsyncContext, logs: LogEntry[]): void {
    const consoleObj = context.newObject();

    for (const level of ['log', 'info', 'warn', 'error'] as const) {
      const fn = context.newFunction(level, (...args: QuickJSHandle[]) => {
        const parts = args.map((a) => {
          try {
            return stringifyValue(context.dump(a));
          } catch {
            return '[unserializable]';
          }
        });

        logs.push({
          level,
          message: parts.join(' '),
          timestamp: Date.now(),
        });
      });

      context.setProp(consoleObj, level, fn);
      fn.dispose();
    }

    context.setProp(context.global, 'console', consoleObj);
    consoleObj.dispose();
  }

  // ── FortiManager Proxy ──────────────────────────────────────────

  private setupFortiManagerProxy(context: QuickJSAsyncContext): void {
    const fmgObj = context.newObject();

    // Track API call count to prevent runaway loops
    let apiCallCount = 0;

    // fortimanager.request(method, params) -> Promise<response>
    const requestFn = context.newAsyncifiedFunction(
      'request',
      async (methodHandle: QuickJSHandle, paramsHandle: QuickJSHandle) => {
        // Enforce call limit
        apiCallCount++;
        if (apiCallCount > MAX_API_CALLS_PER_EXECUTION) {
          throw new Error(
            `API call limit exceeded (max ${String(MAX_API_CALLS_PER_EXECUTION)} calls per execution). ` +
              'Use more targeted queries or batch multiple URLs in a single request.',
          );
        }

        const method = context.getString(methodHandle) as FmgMethod;
        const params = context.dump(paramsHandle) as FmgRequestParams[];

        try {
          const response = await this.client.rawRequest(method, params);
          const responseJson = JSON.stringify(response);
          const responseStr = context.newString(responseJson);
          const parseExpr = context.evalCode('JSON.parse');

          if (parseExpr.error) {
            parseExpr.error.dispose();
            responseStr.dispose();
            return context.newError('Failed to parse response in sandbox');
          }

          const parsed = context.callFunction(parseExpr.value, context.undefined, responseStr);
          parseExpr.value.dispose();
          responseStr.dispose();

          if (parsed.error) {
            const err = context.newError('Failed to parse response');
            parsed.error.dispose();
            return err;
          }

          return parsed.value;
        } catch (err: unknown) {
          const message = err instanceof Error ? err.message : String(err);
          throw new Error(message);
        }
      },
    );

    context.setProp(fmgObj, 'request', requestFn);
    requestFn.dispose();

    context.setProp(context.global, 'fortimanager', fmgObj);
    fmgObj.dispose();
  }
}

// ─── Helpers ────────────────────────────────────────────────────────

function formatError(errorValue: unknown): string {
  if (typeof errorValue === 'string') return errorValue;
  if (errorValue && typeof errorValue === 'object') {
    const err = errorValue as Record<string, unknown>;
    const name = typeof err['name'] === 'string' ? err['name'] : 'Error';
    const message = typeof err['message'] === 'string' ? err['message'] : 'Unknown error';
    const stack = typeof err['stack'] === 'string' ? err['stack'] : undefined;
    if (stack) {
      return `${name}: ${message}\n${stack}`;
    }
    return `${name}: ${message}`;
  }
  return String(errorValue);
}

function stringifyValue(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value === undefined) return 'undefined';
  if (value === null) return 'null';
  try {
    return JSON.stringify(value);
  } catch {
    return typeof value === 'object' ? '[object]' : String(value as string);
  }
}

/**
 * FortiManager JSON-RPC Client
 *
 * Stateless HTTP client for FortiManager's JSON-RPC API (`POST /jsonrpc`).
 * Supports request multiplexing (multiple params in a single request),
 * and all standard FMG methods: get, set, add, update, delete, exec, clone, move.
 */

import { type AuthProvider, createAuthProvider } from './auth.js';
import {
  FmgApiError,
  FmgTransportError,
  type FmgClientConfig,
  type FmgMethod,
  type FmgRequestParams,
  type FmgResponseResult,
  type FmgStatus,
  type JsonRpcRequest,
  type JsonRpcResponse,
} from './types.js';

// ─── Client ─────────────────────────────────────────────────────────

export class FmgClient {
  private readonly endpoint: string;
  private readonly auth: AuthProvider;
  private readonly verifySsl: boolean;
  private requestId = 0;

  constructor(
    private readonly config: FmgClientConfig,
    auth?: AuthProvider,
  ) {
    this.endpoint = `${config.host}:${config.port}/jsonrpc`;
    this.auth = auth ?? createAuthProvider(config);
    this.verifySsl = config.verifySsl;
  }

  // ── Public API Methods ──────────────────────────────────────────

  /** GET — Retrieve object(s) at the given URL */
  async get<T = unknown>(url: string, params?: Partial<FmgRequestParams>): Promise<T> {
    return this.singleRequest<T>('get', { url, ...params });
  }

  /** SET — Replace object(s) at the given URL */
  async set<T = unknown>(
    url: string,
    data: unknown,
    params?: Partial<FmgRequestParams>,
  ): Promise<T> {
    return this.singleRequest<T>('set', { url, data, ...params });
  }

  /** ADD — Create new object(s) at the given URL */
  async add<T = unknown>(
    url: string,
    data: unknown,
    params?: Partial<FmgRequestParams>,
  ): Promise<T> {
    return this.singleRequest<T>('add', { url, data, ...params });
  }

  /** UPDATE — Partially update object(s) at the given URL */
  async update<T = unknown>(
    url: string,
    data: unknown,
    params?: Partial<FmgRequestParams>,
  ): Promise<T> {
    return this.singleRequest<T>('update', { url, data, ...params });
  }

  /** DELETE — Remove object(s) at the given URL */
  async delete<T = unknown>(url: string, params?: Partial<FmgRequestParams>): Promise<T> {
    return this.singleRequest<T>('delete', { url, ...params });
  }

  /** EXEC — Execute a command at the given URL */
  async exec<T = unknown>(
    url: string,
    data?: unknown,
    params?: Partial<FmgRequestParams>,
  ): Promise<T> {
    return this.singleRequest<T>('exec', { url, data, ...params });
  }

  /** CLONE — Clone an object at the given URL */
  async clone<T = unknown>(
    url: string,
    data: unknown,
    params?: Partial<FmgRequestParams>,
  ): Promise<T> {
    return this.singleRequest<T>('clone', { url, data, ...params });
  }

  /** MOVE — Move an object at the given URL */
  async move<T = unknown>(
    url: string,
    data: unknown,
    params?: Partial<FmgRequestParams>,
  ): Promise<T> {
    return this.singleRequest<T>('move', { url, data, ...params });
  }

  // ── Request Multiplexing ────────────────────────────────────────

  /**
   * Send a batch of parameter blocks in a single JSON-RPC request.
   * FMG supports multiple `params` entries in one call.
   */
  async batch<T = unknown>(
    method: FmgMethod,
    paramsList: FmgRequestParams[],
  ): Promise<FmgResponseResult<T>[]> {
    const request = this.buildRequest(method, paramsList);
    const response = await this.sendRequest<T>(request);
    return response.result;
  }

  // ── Raw Request Access ──────────────────────────────────────────

  /**
   * Send a raw JSON-RPC request. Useful for advanced use cases
   * or when called from the sandbox executor.
   */
  async rawRequest<T = unknown>(
    method: FmgMethod,
    params: FmgRequestParams[],
  ): Promise<JsonRpcResponse<T>> {
    const request = this.buildRequest(method, params);
    return this.sendRequest<T>(request);
  }

  // ── Health Check ────────────────────────────────────────────────

  /** Check connectivity by fetching system status */
  async checkHealth(): Promise<{ connected: boolean; version?: string; hostname?: string }> {
    try {
      const data = await this.get<Record<string, string>>('/sys/status');
      return {
        connected: true,
        version: data['Version'],
        hostname: data['Hostname'],
      };
    } catch {
      return { connected: false };
    }
  }

  // ── Internal Methods ────────────────────────────────────────────

  /** Build a JSON-RPC request envelope */
  private buildRequest(method: FmgMethod, params: FmgRequestParams[]): JsonRpcRequest {
    return {
      id: ++this.requestId,
      method,
      params,
      session: this.auth.getSession(),
    };
  }

  /** Send a single-param request and extract the first result's data */
  private async singleRequest<T>(method: FmgMethod, params: FmgRequestParams): Promise<T> {
    const request = this.buildRequest(method, [params]);
    const response = await this.sendRequest<T>(request);

    const result = response.result[0];
    if (!result) {
      throw new FmgApiError('Empty result array', -1, params.url, method);
    }

    this.checkStatus(result.status, params.url, method);

    return result.data as T;
  }

  /** Execute the HTTP request to FortiManager */
  private async sendRequest<T>(request: JsonRpcRequest): Promise<JsonRpcResponse<T>> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      ...this.auth.getAuthHeaders(),
    };

    // Build fetch options
    const fetchOptions: RequestInit = {
      method: 'POST',
      headers,
      body: JSON.stringify(request),
    };

    // Handle SSL verification (Node.js specific)
    if (!this.verifySsl) {
      // @ts-expect-error -- Node.js-specific fetch option for TLS
      fetchOptions.dispatcher = await this.getUnsafeDispatcher();
    }

    let httpResponse: Response;
    try {
      httpResponse = await fetch(this.endpoint, fetchOptions);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      throw new FmgTransportError(
        `Failed to connect to ${this.endpoint}: ${message}`,
        undefined,
        this.endpoint,
      );
    }

    if (!httpResponse.ok) {
      throw new FmgTransportError(
        `HTTP ${httpResponse.status} ${httpResponse.statusText}`,
        httpResponse.status,
        this.endpoint,
      );
    }

    const body = (await httpResponse.json()) as JsonRpcResponse<T>;

    // Update session if returned (for session-based auth)
    if (body.session && this.auth.getSession() !== null) {
      // Session rotation — some FMG versions rotate session IDs
    }

    return body;
  }

  /** Throw FmgApiError if status code indicates failure */
  private checkStatus(status: FmgStatus, url: string, method: FmgMethod): void {
    if (status.code !== 0) {
      throw new FmgApiError(status.message, status.code, url, method, status);
    }
  }

  /**
   * Get an undici dispatcher that skips TLS verification.
   * Only used when FMG_VERIFY_SSL=false (e.g., self-signed certs in lab environments).
   */
  private async getUnsafeDispatcher(): Promise<unknown> {
    try {
      const undici = await import('undici');
      const AgentClass = undici.Agent;
      return new AgentClass({
        connect: { rejectUnauthorized: false },
      });
    } catch {
      console.warn(
        'Cannot disable SSL verification: undici not available. ' +
          'Set FMG_VERIFY_SSL=true or install undici.',
      );
      return undefined;
    }
  }
}

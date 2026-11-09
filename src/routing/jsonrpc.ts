/** JSON-RPC 2.0 types and validation for the Solana HTTP API. */
export type JsonRpcId = string | number | null;

export interface JsonRpcRequest {
  jsonrpc: "2.0";
  id: JsonRpcId;
  method: string;
  params?: unknown[] | Record<string, unknown>;
}

export interface JsonRpcError {
  code: number;
  message: string;
  data?: unknown;
}

export interface JsonRpcSuccess {
  jsonrpc: "2.0";
  id: JsonRpcId;
  result: unknown;
}

export interface JsonRpcFailure {
  jsonrpc: "2.0";
  id: JsonRpcId;
  error: JsonRpcError;
}

export type JsonRpcResponse = JsonRpcSuccess | JsonRpcFailure;

export const PARSE_ERROR: JsonRpcError = { code: -32700, message: "Parse error" };

export function isFailure(r: JsonRpcResponse): r is JsonRpcFailure {
  return "error" in r && r.error !== undefined;
}

export function rpcError(id: JsonRpcId, error: JsonRpcError): JsonRpcFailure {
  return { jsonrpc: "2.0", id, error };
}

export type ParsedBody =
  | { ok: true; batch: boolean; requests: Array<JsonRpcRequest | { invalid: JsonRpcFailure }> }
  | { ok: false; error: JsonRpcFailure; httpStatus: number };

/** Validates a JSON-RPC body (single or batch). Invalid batch items become per-item errors. */
export function parseJsonRpcBody(body: unknown, maxBatch: number): ParsedBody {
  if (Array.isArray(body)) {
    if (body.length === 0) {
      return { ok: false, httpStatus: 400, error: rpcError(null, { code: -32600, message: "Invalid Request: empty batch" }) };
    }
    if (body.length > maxBatch) {
      return {
        ok: false,
        httpStatus: 413,
        error: rpcError(null, { code: -32600, message: `Invalid Request: batch larger than ${maxBatch} items` }),
      };
    }
    return { ok: true, batch: true, requests: body.map(validateOne) };
  }
  const one = validateOne(body);
  if ("invalid" in one) return { ok: false, httpStatus: 400, error: one.invalid };
  return { ok: true, batch: false, requests: [one] };
}

function validateOne(value: unknown): JsonRpcRequest | { invalid: JsonRpcFailure } {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { invalid: rpcError(null, { code: -32600, message: "Invalid Request" }) };
  }
  const v = value as Record<string, unknown>;
  const id = v.id === undefined ? null : v.id;
  if (id !== null && typeof id !== "string" && typeof id !== "number") {
    return { invalid: rpcError(null, { code: -32600, message: "Invalid Request: id must be a string, number or null" }) };
  }
  if (v.jsonrpc !== "2.0") {
    return { invalid: rpcError(id as JsonRpcId, { code: -32600, message: 'Invalid Request: jsonrpc must be "2.0"' }) };
  }
  if (typeof v.method !== "string" || v.method.length === 0 || v.method.length > 128) {
    return { invalid: rpcError(id as JsonRpcId, { code: -32600, message: "Invalid Request: method must be a string" }) };
  }
  if (v.params !== undefined && (typeof v.params !== "object" || v.params === null)) {
    return { invalid: rpcError(id as JsonRpcId, { code: -32602, message: "Invalid params: must be an array or object" }) };
  }
  return {
    jsonrpc: "2.0",
    id: id as JsonRpcId,
    method: v.method,
    params: v.params as JsonRpcRequest["params"],
  };
}

/** Error codes that mean "this node cannot answer right now; another node might". */
export const RETRYABLE_RPC_CODES = new Set<number>([
  -32001, // block cleaned up
  -32004, // block not available for slot
  -32005, // node is unhealthy / behind
  -32010, // key excluded from secondary index (node config)
  -32011, // transaction history not available (node config)
  -32014, // block status not yet available
  -32016, // minimum context slot has not been reached
  -32601, // method not found: this provider does not serve it
  -32603, // internal error
  -32429, // non-standard rate limit
]);

/** Error codes that are a legitimate answer to the caller's request; these are billed. */
export const CLIENT_RPC_CODES = new Set<number>([
  -32600, // invalid request
  -32602, // invalid params
  -32002, // transaction simulation failed (preflight)
  -32003, // transaction signature verification failure
  -32006, // transaction precompile verification failure
  -32007, // slot skipped or missing due to ledger jump
  -32009, // slot skipped
  -32013, // signature length mismatch
  -32015, // transaction version not supported by the caller's settings
]);

export function looksRateLimited(err: JsonRpcError): boolean {
  return err.code === -32429 || /too many requests|rate limit/i.test(err.message);
}

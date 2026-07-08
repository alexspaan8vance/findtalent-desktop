/**
 * Error hierarchy for the 8vance client. All errors extend `VanceError`
 * so callers can branch on a single base class.
 */

import { redact } from "./util";

export class VanceError extends Error {
  readonly endpoint: string;
  readonly status: number;
  readonly body: unknown;
  constructor(endpoint: string, status: number, body: unknown, message?: string) {
    const safeBody = redact(body);
    const summary =
      message ??
      `8vance ${status || "ERR"} ${endpoint}: ${
        typeof safeBody === "string" ? safeBody.slice(0, 300) : JSON.stringify(safeBody).slice(0, 300)
      }`;
    super(summary);
    this.name = "VanceError";
    this.endpoint = endpoint;
    this.status = status;
    this.body = safeBody;
  }
}

export class VanceAuthError extends VanceError {
  constructor(endpoint: string, status: number, body: unknown) {
    super(endpoint, status, body, `8vance auth failed (${status}) ${endpoint}`);
    this.name = "VanceAuthError";
  }
}

export class VanceRateLimitError extends VanceError {
  constructor(endpoint: string, status: number, body: unknown) {
    super(endpoint, status, body, `8vance 429 ${endpoint}`);
    this.name = "VanceRateLimitError";
  }
}

export class CompanyIdGateError extends VanceError {
  readonly companyId: number | string;
  readonly allowed: ReadonlySet<number>;
  constructor(companyId: number | string, allowed: ReadonlySet<number>) {
    const allowedList = [...allowed].sort((a, b) => a - b);
    super(
      "<pre-flight>",
      403,
      {
        company_id: companyId,
        allowed: allowedList,
      },
      `company_id=${String(companyId)} is outside the allow-list (allowed=${JSON.stringify(allowedList)})`,
    );
    this.name = "CompanyIdGateError";
    this.companyId = companyId;
    this.allowed = allowed;
  }
}

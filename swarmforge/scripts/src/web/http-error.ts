/** An error that maps to an HTTP status when it escapes a request handler. */
export class HttpError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export function statusOf(error: unknown, fallback: number): number {
  return error instanceof HttpError ? error.status : fallback;
}

export function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

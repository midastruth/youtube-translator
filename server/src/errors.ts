export class IngestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "IngestError";
  }
}

/** Only backend caption acquisition failures are eligible for browser recovery. */
export class SubtitleIngestionError extends IngestError {
  readonly code = "subtitle_ingestion_failed";
  readonly statusCode: number;

  constructor(cause: unknown) {
    super(cause instanceof Error ? cause.message : String(cause));
    this.name = "SubtitleIngestionError";
    this.cause = cause;
    this.statusCode = (cause as { statusCode?: number } | null)?.statusCode
      || (cause instanceof IngestError ? 400 : 500);
  }
}

export class TranslateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TranslateError";
  }
}

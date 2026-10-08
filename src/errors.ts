export type ArtifactsErrorCode =
  | "ALREADY_EXISTS"
  | "NOT_FOUND"
  | "CREATE_IN_PROGRESS"
  | "IMPORT_IN_PROGRESS"
  | "FORK_IN_PROGRESS"
  | "INVALID_INPUT"
  | "INVALID_REPO_NAME"
  | "INVALID_TTL"
  | "INVALID_URL"
  | "REMOTE_AUTH_REQUIRED"
  | "UPSTREAM_UNAVAILABLE"
  | "MEMORY_LIMIT"
  | "INTERNAL_ERROR";

// Numeric codes match the REST `errors[].code` values in the Artifacts docs.
// CREATE_IN_PROGRESS is absent from the docs table; 10301 is a guess that
// fills the gap before IMPORT_IN_PROGRESS (10302).
const CODES: Record<ArtifactsErrorCode, { numeric: number; status: number }> = {
  INVALID_INPUT: { numeric: 10100, status: 400 },
  INVALID_REPO_NAME: { numeric: 10101, status: 400 },
  INVALID_TTL: { numeric: 10103, status: 400 },
  INVALID_URL: { numeric: 10104, status: 400 },
  REMOTE_AUTH_REQUIRED: { numeric: 10106, status: 400 },
  NOT_FOUND: { numeric: 10200, status: 404 },
  ALREADY_EXISTS: { numeric: 10201, status: 409 },
  CREATE_IN_PROGRESS: { numeric: 10301, status: 409 },
  IMPORT_IN_PROGRESS: { numeric: 10302, status: 409 },
  FORK_IN_PROGRESS: { numeric: 10303, status: 409 },
  INTERNAL_ERROR: { numeric: 10400, status: 500 },
  UPSTREAM_UNAVAILABLE: { numeric: 10401, status: 502 },
  MEMORY_LIMIT: { numeric: 10402, status: 413 },
};

export class ArtifactsError extends Error {
  override readonly name = "ArtifactsError" as const;
  readonly code: ArtifactsErrorCode;
  readonly numericCode: number;

  constructor(code: ArtifactsErrorCode, message: string) {
    super(message);
    this.code = code;
    this.numericCode = CODES[code].numeric;
  }

  /** HTTP status for REST responses. A getter, so own keys match the real error: name, code, numericCode. */
  get status(): number {
    return CODES[this.code].status;
  }
}

export function codeFromNumeric(numeric: number): ArtifactsErrorCode | undefined {
  for (const [code, info] of Object.entries(CODES)) {
    if (info.numeric === numeric) return code as ArtifactsErrorCode;
  }
  return undefined;
}

export function isArtifactsError(err: unknown): err is ArtifactsError {
  return err instanceof ArtifactsError;
}

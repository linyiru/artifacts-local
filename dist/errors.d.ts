export type ArtifactsErrorCode = "ALREADY_EXISTS" | "NOT_FOUND" | "CREATE_IN_PROGRESS" | "IMPORT_IN_PROGRESS" | "FORK_IN_PROGRESS" | "INVALID_INPUT" | "INVALID_REPO_NAME" | "INVALID_TTL" | "INVALID_URL" | "REMOTE_AUTH_REQUIRED" | "UPSTREAM_UNAVAILABLE" | "MEMORY_LIMIT" | "INTERNAL_ERROR";
export declare class ArtifactsError extends Error {
    #private;
    readonly name: "ArtifactsError";
    readonly code: ArtifactsErrorCode;
    readonly numericCode: number;
    /** `pointer` is the JSON pointer of the offending field, sent as REST `source.pointer`. */
    constructor(code: ArtifactsErrorCode, message: string, pointer?: string);
    get pointer(): string | undefined;
    /** The REST `errors[]` entry, shaped like the live service's. */
    toApiError(): {
        code: number;
        message: string;
        documentation_url: string;
        source?: {
            pointer: string;
        };
    };
    /** HTTP status for REST responses. A getter, so own keys match the real error: name, code, numericCode. */
    get status(): number;
}
export declare function codeFromNumeric(numeric: number): ArtifactsErrorCode | undefined;
export declare function isArtifactsError(err: unknown): err is ArtifactsError;

//#region src/errors.ts
const CODES = {
	INVALID_INPUT: {
		numeric: 10100,
		status: 400
	},
	INVALID_REPO_NAME: {
		numeric: 10101,
		status: 400
	},
	INVALID_TTL: {
		numeric: 10103,
		status: 400
	},
	INVALID_URL: {
		numeric: 10104,
		status: 400
	},
	REMOTE_AUTH_REQUIRED: {
		numeric: 10106,
		status: 422
	},
	NOT_FOUND: {
		numeric: 10200,
		status: 404
	},
	ALREADY_EXISTS: {
		numeric: 10201,
		status: 409
	},
	CREATE_IN_PROGRESS: {
		numeric: 10301,
		status: 409
	},
	IMPORT_IN_PROGRESS: {
		numeric: 10302,
		status: 409
	},
	FORK_IN_PROGRESS: {
		numeric: 10303,
		status: 409
	},
	INTERNAL_ERROR: {
		numeric: 10400,
		status: 500
	},
	UPSTREAM_UNAVAILABLE: {
		numeric: 10401,
		status: 502
	},
	MEMORY_LIMIT: {
		numeric: 10402,
		status: 413
	}
};
var ArtifactsError = class extends Error {
	name = "ArtifactsError";
	code;
	numericCode;
	#pointer;
	/** `pointer` is the JSON pointer of the offending field, sent as REST `source.pointer`. */
	constructor(code, message, pointer) {
		super(message);
		this.code = code;
		this.numericCode = CODES[code].numeric;
		this.#pointer = pointer;
	}
	get pointer() {
		return this.#pointer;
	}
	/** The REST `errors[]` entry, shaped like the live service's. */
	toApiError() {
		const out = {
			code: this.numericCode,
			message: this.message,
			documentation_url: `https://developers.cloudflare.com/artifacts/api/errors#${this.numericCode}`
		};
		if (this.#pointer) out.source = { pointer: this.#pointer };
		return out;
	}
	/** HTTP status for REST responses. A getter, so own keys match the real error: name, code, numericCode. */
	get status() {
		return CODES[this.code].status;
	}
};
function isArtifactsError(err) {
	return err instanceof ArtifactsError;
}
//#endregion
export { isArtifactsError as n, ArtifactsError as t };

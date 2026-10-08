import type { Artifacts } from "./types.js";
export interface BindingOptions {
    /** Base URL of the artifacts-local server. */
    url: string;
    namespace: string;
    fetch?: typeof fetch;
}
export declare function createArtifactsBinding(opts: BindingOptions): Artifacts;

//#region src/types.d.ts
interface ArtifactsRepoInfo {
  id: string;
  name: string;
  description: string | null;
  defaultBranch: string;
  createdAt: string;
  updatedAt: string;
  lastPushAt: string | null;
  source: string | null;
  readOnly: boolean;
  remote: string;
}
interface ArtifactsCreateRepoResult {
  id: string;
  name: string;
  description: string | null;
  defaultBranch: string;
  remote: string;
  token: string;
}
interface ArtifactsRepoListResult {
  repos: (Omit<ArtifactsRepoInfo, "remote"> & {
    status: "ready" | "importing" | "forking";
  })[];
  total: number;
  cursor?: string;
}
interface ArtifactsCreateTokenResult {
  id: string;
  plaintext: string;
  scope: "read" | "write";
  expiresAt: string;
}
interface ArtifactsTokenInfo {
  id: string;
  scope: "read" | "write";
  state: "active" | "expired" | "revoked";
  createdAt: string;
  expiresAt: string;
}
interface ArtifactsTokenListResult {
  tokens: ArtifactsTokenInfo[];
  total: number;
}
type ArtifactsTreeEntryType = "tree" | "blob" | "symlink" | "gitlink" | "exec";
interface ArtifactsTreeEntry {
  name: string;
  mode: string;
  hash: string;
  type: ArtifactsTreeEntryType;
}
interface ArtifactsCommitMetadata {
  hash: string;
  treeHash: string;
  message: string;
  author: {
    name: string;
    email: string;
  };
  committer: {
    name: string;
    email: string;
  };
  parents: string[];
  authoredAt: number;
  committedAt: number;
}
interface ArtifactsRepo extends Disposable {
  createToken(scope?: "write" | "read", ttl?: number): Promise<ArtifactsCreateTokenResult>;
  listTokens(): Promise<ArtifactsTokenListResult>;
  revokeToken(tokenOrId: string): Promise<boolean>;
  info(): Promise<ArtifactsRepoInfo>;
  readBlob(hash: string): Promise<Blob | null>;
  readTree(hash: string): Promise<ArtifactsTreeEntry[] | null>;
  readCommit(hash: string): Promise<ArtifactsCommitMetadata | null>;
  readFile(args: {
    ref: string;
    path: string;
  }): Promise<Blob | null>;
  log(opts?: {
    ref?: string;
    limit?: number;
    offset?: number;
  }): Promise<ArtifactsCommitMetadata[]>;
  fork(name: string, opts?: {
    description?: string;
    readOnly?: boolean;
    defaultBranchOnly?: boolean;
  }): Promise<ArtifactsCreateRepoResult>;
}
interface Artifacts {
  create(name: string, opts?: {
    readOnly?: boolean;
    description?: string;
    setDefaultBranch?: string;
  }): Promise<ArtifactsCreateRepoResult>;
  get(name: string): Promise<ArtifactsRepo>;
  import(params: {
    source: {
      url: string;
      branch?: string;
      depth?: number;
    };
    target: {
      name: string;
      opts?: {
        description?: string;
        readOnly?: boolean;
      };
    };
  }): Promise<ArtifactsCreateRepoResult>;
  list(opts?: {
    limit?: number;
    cursor?: string;
  }): Promise<ArtifactsRepoListResult>;
  delete(name: string): Promise<boolean>;
}
//#endregion
//#region src/client.d.ts
interface BindingOptions {
  /** Base URL of the artifacts-local server. */
  url: string;
  namespace: string;
  fetch?: typeof fetch;
}
declare function createArtifactsBinding(opts: BindingOptions): Artifacts;
//#endregion
export { ArtifactsCreateRepoResult as a, ArtifactsRepoInfo as c, ArtifactsTokenListResult as d, ArtifactsTreeEntry as f, ArtifactsCommitMetadata as i, ArtifactsRepoListResult as l, createArtifactsBinding as n, ArtifactsCreateTokenResult as o, ArtifactsTreeEntryType as p, Artifacts as r, ArtifactsRepo as s, BindingOptions as t, ArtifactsTokenInfo as u };
// Just enough of fs.promises for isomorphic-git in a Worker, like the helper in the Artifacts
// isomorphic-git example.

type Entry = { kind: "file"; data: Uint8Array; mtimeMs: number } | { kind: "dir"; mtimeMs: number };

function fsError(code: string, path: string): Error {
  return Object.assign(new Error(`${code}: ${path}`), { code });
}

function normalize(path: string): string {
  const parts: string[] = [];
  for (const p of path.split("/")) {
    if (!p || p === ".") continue;
    if (p === "..") parts.pop();
    else parts.push(p);
  }
  return `/${parts.join("/")}`;
}

function parentOf(path: string): string {
  return normalize(`${path}/..`);
}

class Stats {
  readonly entry: Entry;
  constructor(entry: Entry) {
    this.entry = entry;
  }
  get size(): number {
    return this.entry.kind === "file" ? this.entry.data.byteLength : 0;
  }
  get mode(): number {
    return this.entry.kind === "file" ? 0o100644 : 0o040000;
  }
  get mtimeMs(): number {
    return this.entry.mtimeMs;
  }
  get ctimeMs(): number {
    return this.entry.mtimeMs;
  }
  readonly uid = 1;
  readonly gid = 1;
  readonly dev = 1;
  readonly ino = 1;
  isFile(): boolean {
    return this.entry.kind === "file";
  }
  isDirectory(): boolean {
    return this.entry.kind === "dir";
  }
  isSymbolicLink(): boolean {
    return false;
  }
}

export class MemoryFS {
  private entries = new Map<string, Entry>([["/", { kind: "dir", mtimeMs: Date.now() }]]);

  private get(path: string): Entry {
    const e = this.entries.get(normalize(path));
    if (!e) throw fsError("ENOENT", path);
    return e;
  }

  private ensureParent(path: string): void {
    const parent = parentOf(path);
    if (!this.entries.has(parent)) this.mkdirp(parent);
  }

  private mkdirp(path: string): void {
    const p = normalize(path);
    if (this.entries.has(p)) return;
    this.mkdirp(parentOf(p));
    this.entries.set(p, { kind: "dir", mtimeMs: Date.now() });
  }

  readonly promises = {
    readFile: async (path: string, opts?: { encoding?: string } | string): Promise<Uint8Array | string> => {
      const e = this.get(path);
      if (e.kind !== "file") throw fsError("EISDIR", path);
      const encoding = typeof opts === "string" ? opts : opts?.encoding;
      return encoding === "utf8" ? new TextDecoder().decode(e.data) : e.data;
    },
    writeFile: async (path: string, data: string | Uint8Array): Promise<void> => {
      this.ensureParent(path);
      const bytes = typeof data === "string" ? new TextEncoder().encode(data) : new Uint8Array(data);
      this.entries.set(normalize(path), { kind: "file", data: bytes, mtimeMs: Date.now() });
    },
    unlink: async (path: string): Promise<void> => {
      if (this.get(path).kind !== "file") throw fsError("EISDIR", path);
      this.entries.delete(normalize(path));
    },
    readdir: async (path: string): Promise<string[]> => {
      const dir = normalize(path);
      if (this.get(dir).kind !== "dir") throw fsError("ENOTDIR", path);
      const prefix = dir === "/" ? "/" : `${dir}/`;
      return [...this.entries.keys()]
        .filter((k) => k !== dir && k.startsWith(prefix) && !k.slice(prefix.length).includes("/"))
        .map((k) => k.slice(prefix.length));
    },
    mkdir: async (path: string): Promise<void> => {
      if (this.entries.has(normalize(path))) throw fsError("EEXIST", path);
      this.ensureParent(path);
      this.entries.set(normalize(path), { kind: "dir", mtimeMs: Date.now() });
    },
    rmdir: async (path: string): Promise<void> => {
      this.entries.delete(normalize(path));
    },
    stat: async (path: string): Promise<Stats> => new Stats(this.get(path)),
    lstat: async (path: string): Promise<Stats> => new Stats(this.get(path)),
    readlink: async (path: string): Promise<never> => {
      throw fsError("ENOENT", path);
    },
    symlink: async (_target: string, path: string): Promise<never> => {
      throw fsError("ENOSYS", path);
    },
    chmod: async (): Promise<void> => {},
  };
}

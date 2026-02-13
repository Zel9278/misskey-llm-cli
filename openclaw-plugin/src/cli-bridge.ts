// misskey-cli bridge: spawns 'what' binary and parses JSONL output
import { spawn, execFileSync, ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { createInterface } from "node:readline";
import { existsSync } from "node:fs";
import { execSync } from "node:child_process";

export interface MisskeyNote {
  id: string;
  text: string | null;
  cw: string | null;
  visibility: string;
  createdAt: string;
  user: {
    username: string;
    name: string | null;
    host: string | null;
  };
  renote?: MisskeyNote;
  replyTo?: string;
  fileCount?: number;
  reactionCount?: number;
}

export interface StreamEvent {
  ts: string;
  event: string;
  data: Record<string, unknown>;
}

export class MisskeyCli extends EventEmitter {
  private proc: ChildProcess | null = null;
  private binary: string;

  constructor(binary = "what") {
    super();
    this.binary = binary;
  }

  // Check if the CLI binary is available on the system
  isAvailable(): boolean {
    try {
      // Check if the binary is an absolute path
      if (this.binary.startsWith("/") || this.binary.includes("/")) {
        return existsSync(this.binary);
      }
      // Check if the binary is in PATH
      execSync(`which ${this.binary}`, { stdio: "ignore" });
      return true;
    } catch {
      return false;
    }
  }

  // Start streaming (spawns 'what stream')
  startStream(): boolean {
    if (!this.isAvailable()) {
      this.emit("error", new Error(`CLI binary '${this.binary}' not found in PATH`));
      return false;
    }

    try {
      this.proc = spawn(this.binary, ["stream"], {
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (err) {
      this.emit("error", err);
      return false;
    }

    this.proc.on("error", (err: Error) => {
      this.emit("error", err);
    });

    const rl = createInterface({ input: this.proc.stdout! });
    rl.on("line", (line: string) => {
      try {
        const evt: StreamEvent = JSON.parse(line);
        this.emit("event", evt);
        this.emit(evt.event, evt.data);
      } catch {
        // skip malformed lines
      }
    });

    this.proc.stderr?.on("data", (chunk: Buffer) => {
      this.emit("stderr", chunk.toString());
    });

    this.proc.on("exit", (code: number | null) => {
      this.emit("exit", code);
    });

    return true;
  }

  stopStream(): void {
    if (this.proc) {
      this.proc.kill("SIGTERM");
      this.proc = null;
    }
  }

  // Run a CLI command synchronously and return parsed JSON
  private exec(args: string[]): unknown {
    if (!this.isAvailable()) {
      return { error: `CLI binary '${this.binary}' not found` };
    }
    try {
      const result = execFileSync(this.binary, args, {
        encoding: "utf-8",
        timeout: 30_000,
      });
      try {
        return JSON.parse(result);
      } catch {
        return { raw: result };
      }
    } catch (err) {
      return { error: String(err) };
    }
  }

  post(text: string, opts?: { cw?: string; visibility?: string; replyId?: string; quoteId?: string }): unknown {
    const args = ["post", text];
    if (opts?.cw) args.push("--cw", opts.cw);
    if (opts?.visibility) args.push("--visibility", opts.visibility);
    if (opts?.replyId) args.push("--reply", opts.replyId);
    if (opts?.quoteId) args.push("--quote", opts.quoteId);
    return this.exec(args);
  }

  reply(noteId: string, text: string, opts?: { cw?: string; visibility?: string }): unknown {
    const args = ["reply", noteId, text];
    if (opts?.cw) args.push("--cw", opts.cw);
    if (opts?.visibility) args.push("--visibility", opts.visibility);
    return this.exec(args);
  }

  upload(filePath: string, opts?: { name?: string; folder?: string; nsfw?: boolean }): unknown {
    const args = ["upload", filePath];
    if (opts?.name) args.push("--name", opts.name);
    if (opts?.folder) args.push("--folder", opts.folder);
    if (opts?.nsfw) args.push("--nsfw");
    return this.exec(args);
  }

  postImage(filePath: string, text?: string, opts?: { cw?: string; visibility?: string; nsfw?: boolean }): unknown {
    const args = ["post-image", filePath];
    if (text) args.push(text);
    if (opts?.cw) args.push("--cw", opts.cw);
    if (opts?.visibility) args.push("--visibility", opts.visibility);
    if (opts?.nsfw) args.push("--nsfw");
    return this.exec(args);
  }

  noteShow(noteId: string): unknown {
    return this.exec(["show", noteId]);
  }

  timeline(type = "hybrid", limit = 10): unknown {
    return this.exec(["tl", type, "--limit", String(limit)]);
  }

  search(query: string, limit = 10): unknown {
    return this.exec(["search", query, "--limit", String(limit)]);
  }

  react(noteId: string, reaction: string): unknown {
    return this.exec(["react", noteId, reaction]);
  }

  me(): unknown {
    return this.exec(["me"]);
  }

  notifications(limit = 10): unknown {
    return this.exec(["notif", "--limit", String(limit)]);
  }

  deleteNote(noteId: string): unknown {
    return this.exec(["delete", noteId]);
  }
}

// OpenClaw Misskey channel plugin
// Registers Misskey as a messaging channel using the 'what' CLI binary

import { MisskeyCli } from "./cli-bridge.js";

interface PluginConfig {
  cliBinary?: string;
  mentionOnly?: boolean;
}

interface PluginApi {
  config: Record<string, unknown>;
  logger: {
    info: (...args: unknown[]) => void;
    warn: (...args: unknown[]) => void;
    error: (...args: unknown[]) => void;
  };
  registerChannel: (opts: { plugin: unknown }) => void;
  registerTool: (tool: unknown) => void;
  registerService: (service: unknown) => void;
  registerCli: (fn: (ctx: { program: unknown }) => void, opts: { commands: string[] }) => void;
  registerCommand: (cmd: unknown) => void;
}

function getPluginConfig(api: PluginApi): PluginConfig {
  const entries = (api.config as Record<string, unknown>)?.plugins as Record<string, unknown> | undefined;
  const misskey = (entries?.entries as Record<string, unknown>)?.misskey as Record<string, unknown> | undefined;
  return (misskey?.config as PluginConfig) ?? {};
}

function getChannelConfig(api: PluginApi): Record<string, unknown> {
  const channels = (api.config as Record<string, unknown>)?.channels as Record<string, unknown> | undefined;
  return (channels?.misskey as Record<string, unknown>) ?? {};
}

export default function register(api: PluginApi) {
  const pluginCfg = getPluginConfig(api);
  const cli = new MisskeyCli(pluginCfg.cliBinary || "what");

  // ---- Register as a messaging channel ----
  const channelPlugin = {
    id: "misskey",
    meta: {
      id: "misskey",
      label: "Misskey",
      selectionLabel: "Misskey (Streaming API)",
      docsPath: "/channels/misskey",
      blurb: "Connect to a Misskey instance via Streaming WebSocket.",
      aliases: ["mk"],
    },
    capabilities: {
      chatTypes: ["direct", "group"] as const,
    },
    config: {
      listAccountIds: (_cfg: Record<string, unknown>) => {
        const ch = getChannelConfig({ config: _cfg } as PluginApi);
        return Object.keys((ch?.accounts as Record<string, unknown>) ?? { default: true });
      },
      resolveAccount: (_cfg: Record<string, unknown>, accountId?: string) => {
        const ch = getChannelConfig({ config: _cfg } as PluginApi);
        const accounts = (ch?.accounts as Record<string, unknown>) ?? {};
        return accounts[accountId ?? "default"] ?? { accountId };
      },
    },
    outbound: {
      deliveryMode: "direct" as const,
      sendText: async ({ text, context }: { text: string; context?: Record<string, unknown> }) => {
        try {
          const replyId = context?.replyToNoteId as string | undefined;
          if (replyId) {
            cli.reply(replyId, text);
          } else {
            cli.post(text);
          }
          return { ok: true };
        } catch (err) {
          api.logger.error("[misskey] sendText failed:", err);
          return { ok: false };
        }
      },
    },
  };

  api.registerChannel({ plugin: channelPlugin });

  // ---- Register agent tools ----
  api.registerTool({
    name: "misskey_post",
    description: "Post a note to Misskey. Supports CW, visibility, reply, and quote.",
    parameters: {
      type: "object",
      properties: {
        text: { type: "string", description: "Note text" },
        cw: { type: "string", description: "Content warning (optional)" },
        visibility: { type: "string", enum: ["public", "home", "followers", "specified"], description: "Visibility (default: public)" },
        replyId: { type: "string", description: "Note ID to reply to (optional)" },
        quoteId: { type: "string", description: "Note ID to quote (optional)" },
      },
      required: ["text"],
    },
    handler: async (params: Record<string, string>) => {
      const result = cli.post(params.text, {
        cw: params.cw,
        visibility: params.visibility,
        replyId: params.replyId,
        quoteId: params.quoteId,
      });
      return { content: JSON.stringify(result) };
    },
  });

  api.registerTool({
    name: "misskey_timeline",
    description: "Fetch the Misskey timeline (hybrid, local, global, or home).",
    parameters: {
      type: "object",
      properties: {
        type: { type: "string", enum: ["hybrid", "local", "global", "home"], description: "Timeline type (default: hybrid)" },
        limit: { type: "number", description: "Number of notes to fetch (default: 10)" },
      },
    },
    handler: async (params: Record<string, unknown>) => {
      const result = cli.timeline(
        (params.type as string) ?? "hybrid",
        (params.limit as number) ?? 10,
      );
      return { content: JSON.stringify(result) };
    },
  });

  api.registerTool({
    name: "misskey_search",
    description: "Search notes on Misskey.",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "Search query" },
        limit: { type: "number", description: "Number of results (default: 10)" },
      },
      required: ["query"],
    },
    handler: async (params: Record<string, unknown>) => {
      const result = cli.search(
        params.query as string,
        (params.limit as number) ?? 10,
      );
      return { content: JSON.stringify(result) };
    },
  });

  api.registerTool({
    name: "misskey_react",
    description: "Add a reaction to a Misskey note.",
    parameters: {
      type: "object",
      properties: {
        noteId: { type: "string", description: "Note ID to react to" },
        reaction: { type: "string", description: "Reaction emoji (e.g. :star:)" },
      },
      required: ["noteId", "reaction"],
    },
    handler: async (params: Record<string, string>) => {
      const result = cli.react(params.noteId, params.reaction);
      return { content: JSON.stringify(result) };
    },
  });

  api.registerTool({
    name: "misskey_notifications",
    description: "Fetch recent Misskey notifications.",
    parameters: {
      type: "object",
      properties: {
        limit: { type: "number", description: "Number of notifications (default: 10)" },
      },
    },
    handler: async (params: Record<string, unknown>) => {
      const result = cli.notifications((params.limit as number) ?? 10);
      return { content: JSON.stringify(result) };
    },
  });

  api.registerTool({
    name: "misskey_note_show",
    description: "Show details of a specific Misskey note by ID.",
    parameters: {
      type: "object",
      properties: {
        noteId: { type: "string", description: "Note ID" },
      },
      required: ["noteId"],
    },
    handler: async (params: Record<string, string>) => {
      const result = cli.noteShow(params.noteId);
      return { content: JSON.stringify(result) };
    },
  });

  // ---- Background service: stream listener ----
  api.registerService({
    id: "misskey-stream",
    start: () => {
      api.logger.info("[misskey] Starting stream listener...");

      if (!cli.isAvailable()) {
        api.logger.warn(
          `[misskey] CLI binary not found. Stream listener disabled. ` +
          `Set plugins.entries.misskey.config.cliBinary to the path of the 'what' binary.`,
        );
        return;
      }

      const started = cli.startStream();
      if (!started) {
        api.logger.warn("[misskey] Failed to start stream listener.");
        return;
      }

      cli.on("error", (err: Error) => {
        api.logger.error(`[misskey] Stream error: ${err.message}`);
      });

      cli.on("note", (data: Record<string, unknown>) => {
        const note = data.note as Record<string, unknown>;
        if (!note) return;

        const user = note.user as Record<string, unknown>;
        const text = note.text as string;
        const noteId = note.id as string;

        if (pluginCfg.mentionOnly && text) {
          // In mention-only mode, skip notes that don't mention the bot
          // (Actual bot username check would require calling 'what me' once)
        }

        api.logger.info(
          `[misskey] @${user?.username}: ${text?.slice(0, 100) ?? "(no text)"}`,
        );
      });

      cli.on("mention", (data: Record<string, unknown>) => {
        const note = data.note as Record<string, unknown>;
        api.logger.info(`[misskey] Mention received: ${(note?.id as string) ?? "?"}`);
      });

      cli.on("exit", (code: number | null) => {
        api.logger.warn(`[misskey] Stream process exited with code ${code}`);
      });
    },
    stop: () => {
      api.logger.info("[misskey] Stopping stream listener...");
      cli.stopStream();
    },
  });

  // ---- Auto-reply commands ----
  api.registerCommand({
    name: "mkpost",
    description: "Post a note to Misskey (e.g. /mkpost Hello world)",
    acceptsArgs: true,
    requireAuth: true,
    handler: async (ctx: { args?: string }) => {
      const text = ctx.args?.trim();
      if (!text) return { text: "Usage: /mkpost <text>" };
      try {
        cli.post(text);
        return { text: `Posted: ${text.slice(0, 100)}` };
      } catch (err) {
        return { text: `Failed to post: ${err}` };
      }
    },
  });

  api.registerCommand({
    name: "mktl",
    description: "Fetch latest Misskey timeline",
    acceptsArgs: false,
    requireAuth: true,
    handler: async () => {
      try {
        const tl = cli.timeline("hybrid", 5) as Array<Record<string, unknown>>;
        if (!Array.isArray(tl)) return { text: JSON.stringify(tl) };
        const lines = tl.map((n) => {
          const u = n.user as Record<string, unknown>;
          return `@${u?.username}: ${((n.text as string) ?? "").slice(0, 80)}`;
        });
        return { text: lines.join("\n") || "(empty)" };
      } catch (err) {
        return { text: `Failed: ${err}` };
      }
    },
  });

  api.logger.info("[misskey] Plugin registered");
}

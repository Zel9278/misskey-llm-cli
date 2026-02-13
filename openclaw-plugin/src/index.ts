// OpenClaw Misskey channel plugin
// Registers Misskey as a messaging channel using the 'what' CLI binary
// Supports inbound message delivery via gateway adapter + outbound via sendText

import { MisskeyCli } from "./cli-bridge.js";

// ---- Types ----

interface PluginConfig {
  cliBinary?: string;
  mentionOnly?: boolean;
  adminUsers?: string[];
}

interface Logger {
  info: (...args: unknown[]) => void;
  warn: (...args: unknown[]) => void;
  error: (...args: unknown[]) => void;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type PluginRuntime = any;

interface PluginApi {
  config: Record<string, unknown>;
  logger: Logger;
  runtime: PluginRuntime;
  registerChannel: (opts: { plugin: unknown }) => void;
  registerTool: (tool: unknown) => void;
  registerService: (service: unknown) => void;
  registerCli: (fn: (ctx: { program: unknown }) => void, opts: { commands: string[] }) => void;
  registerCommand: (cmd: unknown) => void;
}

// ---- Module-level runtime reference ----
let rt: PluginRuntime = null;
let log: Logger = console;

function setRuntime(api: PluginApi) {
  rt = api.runtime;
  log = api.logger;
}

// ---- Config helpers ----

function getPluginConfig(api: PluginApi): PluginConfig {
  const entries = (api.config as Record<string, unknown>)?.plugins as Record<string, unknown> | undefined;
  const misskey = (entries?.entries as Record<string, unknown>)?.misskey as Record<string, unknown> | undefined;
  return (misskey?.config as PluginConfig) ?? {};
}

// ---- Access control helpers ----

let _pluginCfg: PluginConfig = {};

function isAdmin(username: string): boolean {
  if (!_pluginCfg.adminUsers?.length) return false;
  return _pluginCfg.adminUsers.includes(username);
}

function resolveChannelConfig(cfg: Record<string, unknown>): Record<string, unknown> {
  const channels = cfg?.channels as Record<string, unknown> | undefined;
  return (channels?.misskey as Record<string, unknown>) ?? {};
}

// ---- Inbound message handler ----

function buildSenderLabel(user: Record<string, unknown>): string {
  const username = user?.username as string ?? "unknown";
  const host = user?.host as string | null;
  const name = user?.name as string | null;
  const handle = host ? `@${username}@${host}` : `@${username}`;
  return name ? `${name} (${handle})` : handle;
}

async function deliverInbound(
  cfg: Record<string, unknown>,
  accountId: string,
  note: Record<string, unknown>,
  cli: MisskeyCli,
) {
  if (!rt?.channel) {
    log.warn("[misskey] runtime.channel not available; cannot deliver inbound message");
    return;
  }

  const user = note.user as Record<string, unknown>;
  const text = note.text as string | null;
  const noteId = note.id as string;
  const senderId = (user?.id as string) ?? "unknown";
  const senderLabel = buildSenderLabel(user);
  const isDirect = (note.visibility as string) === "specified";
  // Collect visibleUserIds for DM replies (include original sender)
  const visibleUserIds: string[] = isDirect
    ? Array.from(new Set([
        senderId,
        ...((note.visibleUserIds as string[]) ?? []),
      ]))
    : [];

  if (!text) return; // skip empty notes (renotes without text, etc.)

  try {
    // Step 1: Route to agent
    const route = rt.channel.routing.resolveAgentRoute({
      cfg,
      channel: "misskey",
      accountId,
      peer: { kind: isDirect ? "direct" : "group", id: senderId },
    });

    // Step 2: Resolve session store path
    const storePath = rt.channel.session.resolveStorePath(
      (cfg.session as Record<string, unknown>)?.store,
      { agentId: route.agentId },
    );

    // Step 3: Get envelope format options
    const envelopeOptions = rt.channel.reply.resolveEnvelopeFormatOptions(cfg);
    const previousTimestamp = rt.channel.session.readSessionUpdatedAt({
      storePath,
      sessionKey: route.sessionKey,
    });

    // Step 4: Format inbound envelope
    const body = rt.channel.reply.formatInboundEnvelope({
      channel: "Misskey",
      from: senderLabel,
      timestamp: Date.now(),
      body: text,
      chatType: isDirect ? "direct" : "group",
      sender: { name: (user?.name as string) ?? (user?.username as string), id: senderId },
      previousTimestamp,
      envelope: envelopeOptions,
    });

    // Step 5: Finalize inbound context
    const ctx = rt.channel.reply.finalizeInboundContext({
      Body: body,
      RawBody: text,
      CommandBody: text,
      From: senderId,
      To: senderId,
      SessionKey: route.sessionKey,
      AccountId: accountId,
      ChatType: isDirect ? "direct" : "group",
      ConversationLabel: senderLabel,
      SenderName: senderLabel,
      SenderId: senderId,
      Provider: "misskey",
      Surface: "misskey",
      MessageSid: noteId,
      Timestamp: Date.now(),
      CommandAuthorized: true,
      OriginatingChannel: "misskey",
      OriginatingTo: senderId,
    });

    // Step 6: Record session
    await rt.channel.session.recordInboundSession({
      storePath,
      sessionKey: ctx.SessionKey || route.sessionKey,
      ctx,
      updateLastRoute: {
        sessionKey: route.mainSessionKey,
        channel: "misskey",
        to: senderId,
        accountId,
      },
      onRecordError: (err: unknown) => log.error("[misskey] Session record failed:", err),
    });

    // Step 7: Dispatch to agent and deliver reply
    await rt.channel.reply.dispatchReplyWithBufferedBlockDispatcher({
      ctx,
      cfg,
      dispatcherOptions: {
        responsePrefix: "",
        deliver: async (payload: { markdown?: string; text?: string }) => {
          const replyText = payload.markdown || payload.text;
          if (!replyText) return;
          try {
            if (isDirect) {
              // Reply to DM: must set visibility=specified and visibleUserIds
              cli.reply(noteId, replyText, {
                visibility: "specified",
                visibleUserIds,
              });
            } else {
              cli.reply(noteId, replyText);
            }
          } catch (err) {
            log.error("[misskey] Reply delivery failed:", err);
          }
        },
      },
    });
  } catch (err) {
    log.error("[misskey] Inbound delivery pipeline failed:", err);
    // Log the available runtime keys for debugging
    if (rt?.channel) {
      log.info("[misskey] runtime.channel keys:", Object.keys(rt.channel));
      if (rt.channel.routing) log.info("[misskey] routing keys:", Object.keys(rt.channel.routing));
      if (rt.channel.reply) log.info("[misskey] reply keys:", Object.keys(rt.channel.reply));
      if (rt.channel.session) log.info("[misskey] session keys:", Object.keys(rt.channel.session));
    } else {
      log.info("[misskey] runtime keys:", rt ? Object.keys(rt) : "null");
    }
  }
}

// ---- Plugin entry point ----

export default function register(api: PluginApi) {
  setRuntime(api);
  const pluginCfg = getPluginConfig(api);
  _pluginCfg = pluginCfg;
  const cli = new MisskeyCli(pluginCfg.cliBinary || "what");

  if (pluginCfg.adminUsers?.length) {
    log.info(`[misskey] adminUsers: ${pluginCfg.adminUsers.join(", ")}`);
  }

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
      listAccountIds: (cfg: Record<string, unknown>) => {
        const ch = resolveChannelConfig(cfg);
        return Object.keys((ch?.accounts as Record<string, unknown>) ?? { default: true });
      },
      resolveAccount: (cfg: Record<string, unknown>, accountId?: string) => {
        const ch = resolveChannelConfig(cfg);
        const accounts = (ch?.accounts as Record<string, unknown>) ?? {};
        return accounts[accountId ?? "default"] ?? { accountId };
      },
    },
    outbound: {
      deliveryMode: "direct" as const,
      sendText: async ({ to, text, cfg, accountId, replyToId, threadId }: {
        to: string;
        text: string;
        cfg: Record<string, unknown>;
        accountId?: string;
        replyToId?: string;
        threadId?: string;
        deps?: unknown;
      }) => {
        try {
          let result: unknown;
          if (replyToId) {
            result = cli.reply(replyToId, text);
          } else {
            result = cli.post(text);
          }
          const noteId = (result as Record<string, unknown>)?.createdNote
            ? ((result as Record<string, unknown>).createdNote as Record<string, unknown>)?.id
            : (result as Record<string, unknown>)?.id;
          return { channel: "misskey", messageId: (noteId as string) ?? String(Date.now()) };
        } catch (err) {
          log.error("[misskey] sendText failed:", err);
          return { channel: "misskey", messageId: String(Date.now()) };
        }
      },
      sendMedia: async ({ to, text, mediaUrl, cfg, accountId, replyToId }: {
        to: string;
        text?: string;
        mediaUrl?: string;
        cfg: Record<string, unknown>;
        accountId?: string;
        replyToId?: string;
        deps?: unknown;
      }) => {
        try {
          // Combine text and media URL since Misskey doesn't have a native media-from-URL API
          const message = mediaUrl ? `${text || ""}\n${mediaUrl}`.trim() : (text || "");
          let result: unknown;
          if (replyToId) {
            result = cli.reply(replyToId, message);
          } else {
            result = cli.post(message);
          }
          const noteId = (result as Record<string, unknown>)?.createdNote
            ? ((result as Record<string, unknown>).createdNote as Record<string, unknown>)?.id
            : (result as Record<string, unknown>)?.id;
          return { channel: "misskey", messageId: (noteId as string) ?? String(Date.now()) };
        } catch (err) {
          log.error("[misskey] sendMedia failed:", err);
          return { channel: "misskey", messageId: String(Date.now()) };
        }
      },
    },

    // ---- Gateway adapter: starts/stops WebSocket stream ----
    gateway: {
      startAccount: async (ctx: {
        account: Record<string, unknown>;
        cfg: Record<string, unknown>;
        abortSignal?: AbortSignal;
        log?: Logger;
        updateSnapshot?: (snapshot: Record<string, unknown>) => void;
      }) => {
        const gatewayLog = ctx.log ?? log;
        const accountId = (ctx.account?.accountId as string) ?? "default";
        const cfg = ctx.cfg;

        gatewayLog.info(`[misskey] Starting gateway for account: ${accountId}`);

        if (!cli.isAvailable()) {
          gatewayLog.warn(
            `[misskey] CLI binary not found. Gateway disabled. ` +
            `Set plugins.entries.misskey.config.cliBinary or install 'what' in PATH.`,
          );
          ctx.updateSnapshot?.({ running: false, error: "CLI binary not found" });
          return { stop: () => {} };
        }

        const started = cli.startStream({ autoReconnect: true });
        if (!started) {
          gatewayLog.warn("[misskey] Failed to start stream.");
          ctx.updateSnapshot?.({ running: false, error: "Stream start failed" });
          return { stop: () => {} };
        }

        ctx.updateSnapshot?.({ running: true, lastStartAt: new Date().toISOString() });

        cli.on("error", (err: Error) => {
          gatewayLog.error(`[misskey] Stream error: ${err.message}`);
        });

        cli.on("reconnecting", (info: { attempt: number; delayMs: number }) => {
          gatewayLog.warn(`[misskey] Stream disconnected. Reconnecting in ${info.delayMs}ms (attempt #${info.attempt})...`);
          ctx.updateSnapshot?.({ running: false, reconnecting: true });
        });

        cli.on("reconnect", (info: { attempt: number }) => {
          gatewayLog.info(`[misskey] Reconnecting stream (attempt #${info.attempt})...`);
          ctx.updateSnapshot?.({ running: true, reconnecting: false, lastReconnectAt: new Date().toISOString() });
        });

        // Handle mention events -> deliver to agent
        cli.on("mention", (data: Record<string, unknown>) => {
          const note = data.note as Record<string, unknown>;
          if (!note) return;
          gatewayLog.info(`[misskey] Mention from @${(note.user as Record<string, unknown>)?.username}: ${((note.text as string) ?? "").slice(0, 80)}`);
          deliverInbound(cfg, accountId, note, cli).catch((err) => {
            gatewayLog.error("[misskey] deliverInbound (mention) failed:", err);
          });
        });

        // Handle timeline notes (if not mention-only mode)
        if (!pluginCfg.mentionOnly) {
          cli.on("note", (data: Record<string, unknown>) => {
            const note = data.note as Record<string, unknown>;
            if (!note) return;
            const user = note.user as Record<string, unknown>;
            gatewayLog.info(`[misskey] Note @${user?.username}: ${((note.text as string) ?? "").slice(0, 80)}`);
            // Only deliver notes that have text (skip renotes without comment)
            if (note.text) {
              deliverInbound(cfg, accountId, note, cli).catch((err) => {
                gatewayLog.error("[misskey] deliverInbound (note) failed:", err);
              });
            }
          });
        }

        cli.on("exit", (code: number | null) => {
          gatewayLog.warn(`[misskey] Stream process exited with code ${code}`);
          ctx.updateSnapshot?.({ running: false, lastStopAt: new Date().toISOString() });
        });

        // Handle abort signal
        ctx.abortSignal?.addEventListener("abort", () => {
          gatewayLog.info("[misskey] Abort signal received, stopping stream.");
          cli.stopStream();
        });

        return {
          stop: () => {
            gatewayLog.info("[misskey] Stopping gateway stream...");
            cli.stopStream();
            ctx.updateSnapshot?.({ running: false, lastStopAt: new Date().toISOString() });
          },
        };
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
    execute: async (_id: string, params: Record<string, string>) => {
      const result = cli.post(params.text, {
        cw: params.cw,
        visibility: params.visibility,
        replyId: params.replyId,
        quoteId: params.quoteId,
      });
      return { content: [{ type: "text", text: JSON.stringify(result) }] };
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
    execute: async (_id: string, params: Record<string, unknown>) => {
      const result = cli.timeline(
        (params.type as string) ?? "hybrid",
        (params.limit as number) ?? 10,
      );
      return { content: [{ type: "text", text: JSON.stringify(result) }] };
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
    execute: async (_id: string, params: Record<string, unknown>) => {
      const result = cli.search(
        params.query as string,
        (params.limit as number) ?? 10,
      );
      return { content: [{ type: "text", text: JSON.stringify(result) }] };
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
    execute: async (_id: string, params: Record<string, string>) => {
      const result = cli.react(params.noteId, params.reaction);
      return { content: [{ type: "text", text: JSON.stringify(result) }] };
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
    execute: async (_id: string, params: Record<string, unknown>) => {
      const result = cli.notifications((params.limit as number) ?? 10);
      return { content: [{ type: "text", text: JSON.stringify(result) }] };
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
    execute: async (_id: string, params: Record<string, string>) => {
      const result = cli.noteShow(params.noteId);
      return { content: [{ type: "text", text: JSON.stringify(result) }] };
    },
  });

  api.registerTool({
    name: "misskey_upload",
    description: "Upload a file to Misskey Drive and return the file object (including id).",
    parameters: {
      type: "object",
      properties: {
        filePath: { type: "string", description: "Absolute path to the file to upload" },
        name: { type: "string", description: "Override file name (optional)" },
        folder: { type: "string", description: "Folder ID to upload into (optional)" },
        nsfw: { type: "boolean", description: "Mark as NSFW/sensitive (default: false)" },
      },
      required: ["filePath"],
    },
    execute: async (_id: string, params: Record<string, unknown>) => {
      const result = cli.upload(params.filePath as string, {
        name: params.name as string | undefined,
        folder: params.folder as string | undefined,
        nsfw: params.nsfw as boolean | undefined,
      });
      return { content: [{ type: "text", text: JSON.stringify(result) }] };
    },
  });

  api.registerTool({
    name: "misskey_post_image",
    description: "Upload a file and post it as a note with optional text. Supports reply and quote. Combines upload + post in one step.",
    parameters: {
      type: "object",
      properties: {
        filePath: { type: "string", description: "Absolute path to the image/file to post" },
        text: { type: "string", description: "Note text (optional)" },
        cw: { type: "string", description: "Content warning (optional)" },
        visibility: { type: "string", enum: ["public", "home", "followers", "specified"], description: "Visibility (default: public)" },
        nsfw: { type: "boolean", description: "Mark file as NSFW/sensitive (default: false)" },
        replyId: { type: "string", description: "Note ID to reply to (optional, for attaching images to a reply)" },
        quoteId: { type: "string", description: "Note ID to quote (optional)" },
      },
      required: ["filePath"],
    },
    execute: async (_id: string, params: Record<string, unknown>) => {
      const result = cli.postImage(params.filePath as string, params.text as string | undefined, {
        cw: params.cw as string | undefined,
        visibility: params.visibility as string | undefined,
        nsfw: params.nsfw as boolean | undefined,
        replyId: params.replyId as string | undefined,
        quoteId: params.quoteId as string | undefined,
      });
      return { content: [{ type: "text", text: JSON.stringify(result) }] };
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

  // Log runtime capabilities for debugging
  if (rt) {
    log.info("[misskey] runtime available, keys:", Object.keys(rt));
    if (rt.channel) {
      log.info("[misskey] runtime.channel keys:", Object.keys(rt.channel));
    }
  } else {
    log.warn("[misskey] runtime not available");
  }

  log.info("[misskey] Plugin registered");
}

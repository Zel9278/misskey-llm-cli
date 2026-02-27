// OpenClaw Misskey channel plugin
// Registers Misskey as a messaging channel using the 'what' CLI binary
// Supports inbound message delivery via gateway adapter + outbound via sendText

import { MisskeyCli } from "./cli-bridge.js";
// [emoji-gen disabled] import { execSync as emojiExecSync } from "node:child_process";
// [emoji-gen disabled] import { unlinkSync } from "node:fs";

// ---- Types ----

interface PluginConfig {
  cliBinary?: string;
  mentionOnly?: boolean;
  adminUsers?: string[];
  allowedUsers?: string[]; // userId allowlist (if set, only these users can trigger responses)
  autonomousPost?: {
    enabled?: boolean;
    intervalMinutes?: number;
    visibility?: string;
    prompt?: string;
  };
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

// Active reply context: set during inbound message processing so tools
// can auto-fill replyId/visibility even when the LLM omits them.
interface ReplyContext {
  noteId: string;
  visibility: string;
  visibleUserIds: string[];
  isDirect: boolean;
}
let _activeReplyCtx: ReplyContext | null = null;

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

function isAllowedUser(userId: string): boolean {
  if (!_pluginCfg.allowedUsers?.length) return true; // if no allowlist, allow all
  return _pluginCfg.allowedUsers.includes(userId);
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
  processedNotes?: Set<string>,
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

  // Build Misskey metadata block for agent context
  const visibility = (note.visibility as string) ?? "public";
  const username = (user?.username as string) ?? "unknown";
  const userHost = (user?.host as string | null) ?? null;
  const cw = (note.cw as string | null) ?? null;
  const replyId = (note.replyId as string | null) ?? null;
  const renoteId = (note.renoteId as string | null) ?? null;
  const misskeyMeta: Record<string, unknown> = {
    noteId,
    userId: senderId,
    username,
    userHost,
    visibility,
    cw,
    replyId,
    renoteId,
  };
  if (visibleUserIds.length > 0) misskeyMeta.visibleUserIds = visibleUserIds;

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
    // Build instruction block so the LLM knows how to reply correctly
    const replyInstruction = [
      `\n\n--- Misskey Context ---`,
      `This message is noteId: ${noteId} (from userId: ${senderId}, visibility: ${visibility})`,
      `IMPORTANT: When using misskey_post, misskey_post_image, or any posting tool to respond to this message, you MUST set replyId to "${noteId}" so your response is threaded as a reply.`,
      isDirect ? `This is a DM. You MUST set visibility to "specified" and visibleUserIds to ${JSON.stringify(visibleUserIds)}.` : "",
      `Full metadata: ${JSON.stringify(misskeyMeta)}`,
    ].filter(Boolean).join("\n");
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

    // Append Misskey context after envelope formatting to ensure it's not stripped
    const bodyWithMeta = body + replyInstruction;

    // Build rich conversation label with Misskey context
    const conversationLabel = `${senderLabel} | noteId:${noteId} | userId:${senderId} | vis:${visibility}`;

    // Step 5: Finalize inbound context
    const ctx = rt.channel.reply.finalizeInboundContext({
      Body: bodyWithMeta,
      RawBody: text,
      CommandBody: text,
      From: senderId,
      To: senderId,
      SessionKey: route.sessionKey,
      AccountId: accountId,
      ChatType: isDirect ? "direct" : "group",
      ConversationLabel: conversationLabel,
      SenderName: `${senderLabel} (id:${senderId})`,
      SenderId: senderId,
      Provider: "misskey",
      Surface: "misskey",
      MessageSid: noteId,
      Timestamp: Date.now(),
      CommandAuthorized: true,
      OriginatingChannel: "misskey",
      OriginatingTo: senderId,
      // Misskey-specific metadata
      NoteId: noteId,
      UserId: senderId,
      Username: (user?.username as string) ?? "unknown",
      UserHost: (user?.host as string | null) ?? null,
      Visibility: (note.visibility as string) ?? "public",
      ReplyId: (note.replyId as string | null) ?? null,
      RenoteId: (note.renoteId as string | null) ?? null,
      VisibleUserIds: visibleUserIds.length > 0 ? visibleUserIds : undefined,
      CW: (note.cw as string | null) ?? null,
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
    // Set active reply context so tools can auto-fill replyId/visibility
    _activeReplyCtx = { noteId, visibility, visibleUserIds, isDirect };
    try {
    await rt.channel.reply.dispatchReplyWithBufferedBlockDispatcher({
      ctx,
      cfg,
      dispatcherOptions: {
        responsePrefix: "",
        deliver: async (payload: { markdown?: string; text?: string }) => {
          const replyText = payload.markdown || payload.text;
          if (!replyText) return;
          try {
            let result: unknown;
            if (isDirect) {
              // Reply to DM: must set visibility=specified and visibleUserIds
              result = cli.reply(noteId, replyText, {
                visibility: "specified",
                visibleUserIds,
              });
            } else {
              result = cli.reply(noteId, replyText);
            }
            // Pre-register our own reply noteId to prevent self-loop on reprocessing
            if (processedNotes && result) {
              const replyNote = (result as Record<string, unknown>)?.createdNote ?? result;
              const replyNoteId = (replyNote as Record<string, unknown>)?.id as string;
              if (replyNoteId) processedNotes.add(replyNoteId);
            }
          } catch (err) {
            log.error("[misskey] Reply delivery failed:", err);
          }
        },
      },
    });
    } finally {
      _activeReplyCtx = null;
    }
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
  if (pluginCfg.allowedUsers?.length) {
    log.info(`[misskey] allowedUsers (restrictive): ${pluginCfg.allowedUsers.join(", ")}`);
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

        // Startup timestamp: skip notes created before gateway started (with 30s tolerance)
        const gatewayStartedAt = Date.now() - 30_000;

        // Fetch bot's own user ID to filter self-mentions
        let selfUserId: string | null = null;
        try {
          const meResult = cli.me() as Record<string, unknown>;
          selfUserId = (meResult?.id as string) ?? null;
          if (selfUserId) {
            gatewayLog.info(`[misskey] Bot user ID: ${selfUserId}`);
          }
        } catch (err) {
          gatewayLog.warn(`[misskey] Failed to fetch bot user ID (self-mention filter disabled): ${err}`);
        }

        // Deduplication: track recently processed note IDs to avoid duplicates on reconnect
        const processedNotes = new Set<string>();
        const MAX_PROCESSED_NOTES = 2000;
        const pruneProcessed = () => {
          if (processedNotes.size > MAX_PROCESSED_NOTES) {
            // Remove oldest entries (Set preserves insertion order)
            const excess = processedNotes.size - MAX_PROCESSED_NOTES / 2;
            let i = 0;
            for (const id of processedNotes) {
              if (i++ >= excess) break;
              processedNotes.delete(id);
            }
          }
        };

        cli.on("error", (err: unknown) => {
          const msg = err instanceof Error ? err.message : JSON.stringify(err);
          gatewayLog.error(`[misskey] Stream process error: ${msg}`);
        });

        cli.on("stream_error", (data: Record<string, unknown>) => {
          gatewayLog.warn(`[misskey] Stream error: ${data?.code ?? "unknown"}: ${data?.detail ?? ""}`);
        });

        cli.on("stderr", (text: string) => {
          const trimmed = text.trim();
          if (trimmed) gatewayLog.warn(`[misskey] Stream stderr: ${trimmed}`);
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

          const noteId = note.id as string;
          const noteUser = note.user as Record<string, unknown>;
          const noteUserId = noteUser?.id as string;

          // Skip own notes (self-mention loop prevention)
          if (selfUserId && noteUserId === selfUserId) {
            gatewayLog.info(`[misskey] Skipping own mention (noteId: ${noteId})`);
            return;
          }

          // Skip if not in allowed users list
          if (!isAllowedUser(noteUserId)) {
            gatewayLog.info(`[misskey] Skipping mention from non-allowed user (userId: ${noteUserId})`);
            return;
          }

          // Skip already-processed notes (deduplication)
          if (noteId && processedNotes.has(noteId)) return;
          if (noteId) { processedNotes.add(noteId); pruneProcessed(); }

          // Skip notes created before gateway started (stale events on reconnect)
          const noteCreatedAt = note.createdAt ? new Date(note.createdAt as string).getTime() : Date.now();
          if (noteCreatedAt < gatewayStartedAt) {
            gatewayLog.info(`[misskey] Skipping stale mention (noteId: ${noteId}, age: ${Math.round((Date.now() - noteCreatedAt) / 1000)}s)`);
            return;
          }

          gatewayLog.info(`[misskey] Mention from @${noteUser?.username}: ${((note.text as string) ?? "").slice(0, 80)}`);
          deliverInbound(cfg, accountId, note, cli, processedNotes).catch((err) => {
            gatewayLog.error("[misskey] deliverInbound (mention) failed:", err);
          });
        });

        // Handle timeline notes (if not mention-only mode)
        if (!pluginCfg.mentionOnly) {
          cli.on("note", (data: Record<string, unknown>) => {
            const note = data.note as Record<string, unknown>;
            if (!note) return;

            const noteId = note.id as string;
            const noteUser = note.user as Record<string, unknown>;
            const noteUserId = noteUser?.id as string;

            // Skip own notes
            if (selfUserId && noteUserId === selfUserId) return;

            // Skip if not in allowed users list
            if (!isAllowedUser(noteUserId)) {
              return;
            }

            // Skip already-processed notes (deduplication)
            if (noteId && processedNotes.has(noteId)) return;
            if (noteId) { processedNotes.add(noteId); pruneProcessed(); }

            // Skip stale notes on reconnect
            const noteCreatedAt = note.createdAt ? new Date(note.createdAt as string).getTime() : Date.now();
            if (noteCreatedAt < gatewayStartedAt) return;

            gatewayLog.info(`[misskey] Note @${noteUser?.username}: ${((note.text as string) ?? "").slice(0, 80)}`);
            // Only deliver notes that have text (skip renotes without comment)
            if (note.text) {
              deliverInbound(cfg, accountId, note, cli, processedNotes).catch((err) => {
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

        // ---- Periodic autonomous posting ----
        let autonomousTimer: ReturnType<typeof setInterval> | null = null;
        const autoPostCfg = pluginCfg.autonomousPost;
        if (autoPostCfg?.enabled) {
          const intervalMs = (autoPostCfg.intervalMinutes ?? 60) * 60 * 1000;
          const postVisibility = autoPostCfg.visibility ?? "public";
          gatewayLog.info(`[misskey] Autonomous posting enabled: every ${autoPostCfg.intervalMinutes ?? 60} min, visibility: ${postVisibility}`);

          const doAutonomousPost = async () => {
            try {
              gatewayLog.info("[misskey] Triggering autonomous post...");

              // Route to agent (use a synthetic peer for autonomous posts)
              const route = rt.channel.routing.resolveAgentRoute({
                cfg,
                channel: "misskey",
                accountId,
                peer: { kind: "group", id: "_autonomous" },
              });

              const storePath = rt.channel.session.resolveStorePath(
                (cfg.session as Record<string, unknown>)?.store,
                { agentId: route.agentId },
              );

              const envelopeOptions = rt.channel.reply.resolveEnvelopeFormatOptions(cfg);
              const previousTimestamp = rt.channel.session.readSessionUpdatedAt({
                storePath,
                sessionKey: route.sessionKey,
              });

              const defaultPrompt = "You are posting on Misskey (a social media platform). Write a short, casual post about whatever is on your mind right now \u2014 your thoughts, something interesting, a random observation, etc. Be natural and authentic. Write the post text only, no quotes or meta-commentary. Keep it concise (under 200 characters ideally). Post in the language you normally use.";
              const prompt = autoPostCfg.prompt ?? defaultPrompt;

              const body = rt.channel.reply.formatInboundEnvelope({
                channel: "Misskey",
                from: "_system_autonomous",
                timestamp: Date.now(),
                body: prompt,
                chatType: "group",
                sender: { name: "System", id: "_autonomous" },
                previousTimestamp,
                envelope: envelopeOptions,
              });

              const postCtx = rt.channel.reply.finalizeInboundContext({
                Body: body,
                RawBody: prompt,
                CommandBody: prompt,
                From: "_autonomous",
                To: "_autonomous",
                SessionKey: route.sessionKey,
                AccountId: accountId,
                ChatType: "group",
                ConversationLabel: "Autonomous Post",
                SenderName: "System (Autonomous)",
                SenderId: "_autonomous",
                Provider: "misskey",
                Surface: "misskey",
                MessageSid: `auto_${Date.now()}`,
                Timestamp: Date.now(),
                CommandAuthorized: true,
                OriginatingChannel: "misskey",
                OriginatingTo: "_autonomous",
              });

              await rt.channel.session.recordInboundSession({
                storePath,
                sessionKey: postCtx.SessionKey || route.sessionKey,
                ctx: postCtx,
                updateLastRoute: {
                  sessionKey: route.mainSessionKey,
                  channel: "misskey",
                  to: "_autonomous",
                  accountId,
                },
                onRecordError: (err: unknown) => gatewayLog.error("[misskey] Autonomous session record failed:", err),
              });

              await rt.channel.reply.dispatchReplyWithBufferedBlockDispatcher({
                ctx: postCtx,
                cfg,
                dispatcherOptions: {
                  responsePrefix: "",
                  deliver: async (payload: { markdown?: string; text?: string }) => {
                    const postText = payload.markdown || payload.text;
                    if (!postText) return;
                    try {
                      const result = cli.post(postText, { visibility: postVisibility });
                      gatewayLog.info(`[misskey] Autonomous post delivered: ${postText.slice(0, 80)}`);
                    } catch (err) {
                      gatewayLog.error("[misskey] Autonomous post delivery failed:", err);
                    }
                  },
                },
              });
            } catch (err) {
              gatewayLog.error("[misskey] Autonomous post pipeline failed:", err);
            }
          };

          // Start the timer and run first post after a short delay
          setTimeout(() => {
            doAutonomousPost();
          }, 30_000); // first post 30s after startup
          autonomousTimer = setInterval(doAutonomousPost, intervalMs);
        }

        return {
          stop: () => {
            gatewayLog.info("[misskey] Stopping gateway stream...");
            cli.stopStream();
            if (autonomousTimer) {
              clearInterval(autonomousTimer);
              autonomousTimer = null;
            }
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
    description: "Post a note to Misskey. Supports CW, visibility, reply, quote, and polls. IMPORTANT: When replying in a DM context, use the correct visibility (e.g. 'specified') instead of defaulting to 'public'.",
    parameters: {
      type: "object",
      properties: {
        text: { type: "string", description: "Note text" },
        cw: { type: "string", description: "Content warning (optional)" },
        visibility: { type: "string", enum: ["public", "home", "followers", "specified"], description: "Visibility (default: public). Use 'specified' for DMs." },
        replyId: { type: "string", description: "Note ID to reply to (optional)" },
        quoteId: { type: "string", description: "Note ID to quote (optional)" },
        pollChoices: {
          type: "array",
          items: { type: "string" },
          description: "Poll choices (2-10 items, each max 50 chars). Creates a poll attached to the note.",
        },
        pollMultiple: { type: "boolean", description: "Allow multiple votes (default: false)" },
        pollExpiresMinutes: { type: "number", description: "Poll duration in minutes (optional, no expiry if omitted)" },
      },
      required: ["text"],
    },
    execute: async (_id: string, params: Record<string, unknown>) => {
      const pollChoices = params.pollChoices as string[] | undefined;
      const poll = pollChoices?.length
        ? {
            choices: pollChoices,
            multiple: (params.pollMultiple as boolean) ?? false,
            expiresMinutes: params.pollExpiresMinutes as number | undefined,
          }
        : undefined;
      // Auto-fill replyId and visibility from active reply context if not provided
      const replyId = (params.replyId as string) ?? _activeReplyCtx?.noteId;
      const visibility = (params.visibility as string) ?? (_activeReplyCtx?.isDirect ? "specified" : undefined);
      const visibleUserIds = _activeReplyCtx?.isDirect ? _activeReplyCtx.visibleUserIds : undefined;
      const result = cli.post(params.text as string, {
        cw: params.cw as string | undefined,
        visibility,
        replyId,
        quoteId: params.quoteId as string | undefined,
        visibleUserIds,
        poll,
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
    description: "Upload a file and post it as a note with optional text. Supports reply, quote, and visibility. IMPORTANT: Match the visibility of the original note when replying (e.g. use 'specified' for DMs with visibleUserIds).",
    parameters: {
      type: "object",
      properties: {
        filePath: { type: "string", description: "Absolute path to the image/file to post" },
        text: { type: "string", description: "Note text (optional)" },
        cw: { type: "string", description: "Content warning (optional)" },
        visibility: { type: "string", enum: ["public", "home", "followers", "specified"], description: "Visibility (default: public). Use 'specified' for DMs." },
        nsfw: { type: "boolean", description: "Mark file as NSFW/sensitive (default: false)" },
        replyId: { type: "string", description: "Note ID to reply to (optional, for attaching images to a reply)" },
        quoteId: { type: "string", description: "Note ID to quote (optional)" },
        visibleUserIds: {
          type: "array",
          items: { type: "string" },
          description: "User IDs who can see this note (required when visibility is 'specified')",
        },
      },
      required: ["filePath"],
    },
    execute: async (_id: string, params: Record<string, unknown>) => {
      // Auto-fill replyId and visibility from active reply context if not provided
      const replyId = (params.replyId as string) ?? _activeReplyCtx?.noteId;
      const visibility = (params.visibility as string) ?? (_activeReplyCtx?.isDirect ? "specified" : undefined);
      const visibleUserIds = (params.visibleUserIds as string[]) ?? (_activeReplyCtx?.isDirect ? _activeReplyCtx.visibleUserIds : undefined);
      const result = cli.postImage(params.filePath as string, params.text as string | undefined, {
        cw: params.cw as string | undefined,
        visibility,
        nsfw: params.nsfw as boolean | undefined,
        replyId,
        quoteId: params.quoteId as string | undefined,
        visibleUserIds,
      });
      return { content: [{ type: "text", text: JSON.stringify(result) }] };
    },
  });

  api.registerTool({
    name: "misskey_user",
    description: "Look up a Misskey user by username and return their profile (including user ID). Useful to resolve a username to a userId for follow/unfollow.",
    parameters: {
      type: "object",
      properties: {
        username: { type: "string", description: "Username to look up (without @)" },
        host: { type: "string", description: "Remote instance host (optional, for federated users)" },
      },
      required: ["username"],
    },
    execute: async (_id: string, params: Record<string, string>) => {
      const result = cli.userShow(params.username, params.host);
      return { content: [{ type: "text", text: JSON.stringify(result) }] };
    },
  });

  api.registerTool({
    name: "misskey_follow",
    description: "Follow a Misskey user by user ID.",
    parameters: {
      type: "object",
      properties: {
        userId: { type: "string", description: "User ID to follow" },
      },
      required: ["userId"],
    },
    execute: async (_id: string, params: Record<string, string>) => {
      const result = cli.follow(params.userId);
      return { content: [{ type: "text", text: JSON.stringify(result) }] };
    },
  });

  api.registerTool({
    name: "misskey_unfollow",
    description: "Unfollow a Misskey user by user ID.",
    parameters: {
      type: "object",
      properties: {
        userId: { type: "string", description: "User ID to unfollow" },
      },
      required: ["userId"],
    },
    execute: async (_id: string, params: Record<string, string>) => {
      const result = cli.unfollow(params.userId);
      return { content: [{ type: "text", text: JSON.stringify(result) }] };
    },
  });

  api.registerTool({
    name: "misskey_block",
    description: "Block a Misskey user by user ID.",
    parameters: {
      type: "object",
      properties: {
        userId: { type: "string", description: "User ID to block" },
      },
      required: ["userId"],
    },
    execute: async (_id: string, params: Record<string, string>) => {
      const result = cli.block(params.userId);
      return { content: [{ type: "text", text: JSON.stringify(result) }] };
    },
  });

  api.registerTool({
    name: "misskey_unblock",
    description: "Unblock a Misskey user by user ID.",
    parameters: {
      type: "object",
      properties: {
        userId: { type: "string", description: "User ID to unblock" },
      },
      required: ["userId"],
    },
    execute: async (_id: string, params: Record<string, string>) => {
      const result = cli.unblock(params.userId);
      return { content: [{ type: "text", text: JSON.stringify(result) }] };
    },
  });

  // [emoji-gen disabled] misskey_emoji tool — uncomment to re-enable
  // Requires external emoji-gen project with node-canvas + gifenc
  // api.registerTool({
  //   name: "misskey_emoji",
  //   description:
  //     "Generate an animated emoji image from text and post it to Misskey. " +
  //     "Effects: shake(ガタガタ), bounce(びょいんびょいん), rotate(ルーレット), wobble(ねるねる), " +
  //     "sway(ゆらゆら), pulse(ぽよーん), squish(もちもち), blink(BLINK), rainbow(レインボー), " +
  //     "scroll(スクロール), nod(ノリノリ), zoom(ズーム), spiral(スパイラル), jelly(ぷるぷる), " +
  //     "none(静止画). " +
  //     "Fonts: gothic(ゴシック), gothic-black(ゴシック/極太), maru(丸ゴ), maru-black(丸ゴ/極太), " +
  //     "serif(明朝), dela(デラゴシック), akazukin(あかずきんポップ), zero(零ゴシック), " +
  //     "kurobara(黒薔薇シンデレラ), pixel(PixelMplus), hachimaru(はちまるポップ), " +
  //     "chikarayowaku(851チカラヨワク), tamanegi(玉ねぎ楷書「激」), togetoge(極太トゲトゲ), rampart(ランパート). " +
  //     "Generates a GIF (or PNG for static effects) and posts it as a note.",
  //   parameters: {
  //     type: "object",
  //     properties: {
  //       text: { type: "string", description: "Text to render on the emoji (supports multi-line with \\n)" },
  //       effect: {
  //         type: "string",
  //         description: "Animation effect name",
  //         enum: [
  //           "none", "shake", "bounce", "rotate", "wobble", "sway", "pulse",
  //           "squish", "blink", "rainbow", "scroll", "nod", "zoom", "spiral", "jelly",
  //         ],
  //       },
  //       font: {
  //         type: "string",
  //         description: "Font alias (default: gothic)",
  //         enum: [
  //           "gothic", "gothic-black", "maru", "maru-black", "serif", "dela",
  //           "akazukin", "zero", "kurobara", "pixel", "hachimaru",
  //           "chikarayowaku", "tamanegi", "togetoge", "rampart",
  //         ],
  //       },
  //       noteText: { type: "string", description: "Optional note text to accompany the emoji image" },
  //       color: { type: "string", description: "Text color (default: #ffffff)" },
  //       bg: { type: "string", description: "Background color or 'transparent' (default: transparent)" },
  //       size: { type: "number", description: "Canvas size in pixels (default: 128)" },
  //       outlineColor: { type: "string", description: "Outline color (default: #000000, use empty string for no outline)" },
  //       replyId: { type: "string", description: "Note ID to reply to (optional)" },
  //       visibility: { type: "string", enum: ["public", "home", "followers", "specified"], description: "Visibility (default: public). Use 'specified' for DMs." },
  //       visibleUserIds: {
  //         type: "array",
  //         items: { type: "string" },
  //         description: "User IDs who can see this note (required when visibility is 'specified')",
  //       },
  //     },
  //     required: ["text", "effect"],
  //   },
  //   execute: async (_id: string, params: Record<string, unknown>) => {
  //     const emojiGenPath = "/home/tasuhiro/tools/misskey-cli/emoji-gen/emoji-gen.js";
  //     const q = (s: string) => "'" + s.replace(/'/g, "'\\''") + "'";
  //     const args: string[] = [
  //       q(params.text as string),
  //       "--effect", params.effect as string,
  //       "--json",
  //     ];
  //     if (params.color) args.push("--color", q(params.color as string));
  //     if (params.bg) args.push("--bg", q(params.bg as string));
  //     if (params.size) args.push("--size", String(params.size));
  //     if (params.font) args.push("--font", params.font as string);
  //     if (params.outlineColor !== undefined) {
  //       if (params.outlineColor === "") {
  //         args.push("--no-outline");
  //       } else {
  //         args.push("--outline", q(params.outlineColor as string));
  //       }
  //     }
  //
  //     try {
  //       const raw = emojiExecSync(`node ${emojiGenPath} ${args.join(" ")}`, {
  //         encoding: "utf-8",
  //         timeout: 15000,
  //       }).trim();
  //       const genResult = JSON.parse(raw);
  //       if (!genResult.ok) {
  //         return { content: [{ type: "text", text: `Emoji generation failed: ${raw}` }] };
  //       }
  //
  //       const replyId = (params.replyId as string) ?? _activeReplyCtx?.noteId;
  //       const visibility = (params.visibility as string) ?? (_activeReplyCtx?.isDirect ? "specified" : undefined);
  //       const visibleUserIds = (params.visibleUserIds as string[]) ?? (_activeReplyCtx?.isDirect ? _activeReplyCtx.visibleUserIds : undefined);
  //       const postResult = cli.postImage(genResult.path, params.noteText as string | undefined, {
  //         visibility,
  //         replyId,
  //         visibleUserIds,
  //       });
  //
  //       try { unlinkSync(genResult.path); } catch { /* ignore */ }
  //
  //       return { content: [{ type: "text", text: JSON.stringify({ ...genResult, post: postResult }) }] };
  //     } catch (err) {
  //       return { content: [{ type: "text", text: `Emoji generation error: ${err}` }] };
  //     }
  //   },
  // });


  api.registerTool({
    name: "misskey_vote",
    description: "Vote on a poll attached to a Misskey note. The choice is a 0-based index into the poll's choices array.",
    parameters: {
      type: "object",
      properties: {
        noteId: { type: "string", description: "Note ID that has the poll" },
        choice: { type: "number", description: "Choice index (0-based)" },
      },
      required: ["noteId", "choice"],
    },
    execute: async (_id: string, params: Record<string, unknown>) => {
      const result = cli.vote(params.noteId as string, params.choice as number);
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

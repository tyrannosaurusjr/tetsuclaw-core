import fs from 'fs';
import https from 'https';
import path from 'path';
import { Api, Bot } from 'grammy';

import { ASSISTANT_NAME, TRIGGER_PATTERN } from '../config.js';
import { readEnvFile } from '../env.js';
import { processImage } from '../image.js';
import { resolveGroupFolderPath } from '../group-folder.js';
import { logger } from '../logger.js';
import {
  getThreadId,
  loadTopics,
  saveTopics,
  upsertTopic,
} from '../topics-registry.js';
import { transcribeBuffer } from '../transcription.js';
import { registerChannel, ChannelOpts } from './registry.js';
import {
  Channel,
  OnChatMetadata,
  OnInboundMessage,
  RegisteredGroup,
} from '../types.js';

export interface TelegramChannelOpts {
  onMessage: OnInboundMessage;
  onChatMetadata: OnChatMetadata;
  registeredGroups: () => Record<string, RegisteredGroup>;
}

/**
 * Send a message with Telegram Markdown parse mode, falling back to plain text.
 * Claude's output naturally matches Telegram's Markdown v1 format:
 *   *bold*, _italic_, `code`, ```code blocks```, [links](url)
 */
async function sendTelegramMessage(
  api: { sendMessage: Api['sendMessage'] },
  chatId: string | number,
  text: string,
  options: { message_thread_id?: number } = {},
): Promise<void> {
  try {
    await api.sendMessage(chatId, text, {
      ...options,
      parse_mode: 'Markdown',
    });
  } catch (err) {
    // Fallback: send as plain text if Markdown parsing fails
    logger.debug({ err }, 'Markdown send failed, falling back to plain text');
    await api.sendMessage(chatId, text, options);
  }
}

// Bot pool for agent teams: send-only Api instances (no polling)
const poolApis: Api[] = [];
// Maps "{groupFolder}:{senderName}" → pool Api index for stable assignment
const senderBotMap = new Map<string, number>();
let nextPoolIndex = 0;
let mainBotApi: Api | null = null;

// Track the latest message_thread_id per chat (for Topics-enabled groups).
// When a group has Topics enabled, all replies and typing indicators must
// include message_thread_id or Telegram silently drops them.
const chatThreadId = new Map<string, number>();

/**
 * Resolve a topic name to a Telegram forum thread ID.
 * Delegates to the topics-registry module for v2-aware load/save.
 * If the topic has a cached thread ID, returns it. Otherwise creates
 * the forum topic via the Telegram API and persists the entry.
 */
export async function resolveTopicThreadId(
  groupFolder: string,
  topicName: string,
  chatId: string,
): Promise<number | null> {
  if (!mainBotApi) {
    logger.warn('Cannot resolve topic: mainBotApi not initialized');
    return null;
  }

  const groupDir = resolveGroupFolderPath(groupFolder);
  const registry = loadTopics(groupDir);

  // Check if we already have a thread ID for this topic
  const cached = getThreadId(registry, topicName);
  if (cached !== null) {
    return cached;
  }

  // Create the forum topic via Telegram API
  try {
    const numericId = chatId.replace(/^tg:/, '');
    const result = await mainBotApi.createForumTopic(numericId, topicName);
    const threadId = result.message_thread_id;

    // Persist via registry (atomic write, v2 schema)
    upsertTopic(registry, topicName, { thread_id: threadId, source: 'agent' });
    saveTopics(groupDir, registry);
    logger.info(
      { topicName, threadId, chatId, groupFolder },
      'Created forum topic and cached thread ID',
    );

    return threadId;
  } catch (err) {
    logger.error({ err, topicName, chatId }, 'Failed to create forum topic');
    return null;
  }
}

/**
 * Get the main bot API instance (for use by IPC handler).
 */
export function getMainBotApi(): Api | null {
  return mainBotApi;
}

/**
 * Get the latest known forum thread ID for a chat (for routing ephemeral messages).
 * Returns undefined if the chat has no active topic context.
 */
export function getLatestThreadId(chatJid: string): number | undefined {
  return chatThreadId.get(chatJid);
}

/**
 * Initialize send-only Api instances for the bot pool.
 */
export async function initBotPool(tokens: string[]): Promise<void> {
  for (const token of tokens) {
    try {
      const api = new Api(token);
      const me = await api.getMe();
      poolApis.push(api);
      logger.info(
        { username: me.username, id: me.id, poolSize: poolApis.length },
        'Pool bot initialized',
      );
    } catch (err) {
      logger.error({ err }, 'Failed to initialize pool bot');
    }
  }
  if (poolApis.length > 0) {
    logger.info({ count: poolApis.length }, 'Telegram bot pool ready');
  }
}

/**
 * Send a message via a pool bot assigned to the given sender name.
 */
export async function sendPoolMessage(
  chatId: string,
  text: string,
  sender: string,
  groupFolder: string,
  topicThreadId?: number,
): Promise<void> {
  const threadOpts = topicThreadId
    ? { message_thread_id: topicThreadId }
    : chatThreadId.has(chatId)
      ? { message_thread_id: chatThreadId.get(chatId)! }
      : {};

  if (poolApis.length === 0) {
    if (mainBotApi) {
      const numericId = chatId.replace(/^tg:/, '');
      await sendTelegramMessage(mainBotApi, numericId, text, threadOpts);
    }
    return;
  }

  const key = `${groupFolder}:${sender}`;
  let idx = senderBotMap.get(key);
  if (idx === undefined) {
    idx = nextPoolIndex % poolApis.length;
    nextPoolIndex++;
    senderBotMap.set(key, idx);
    try {
      await poolApis[idx].setMyName(sender);
      await new Promise((r) => setTimeout(r, 2000));
      logger.info(
        { sender, groupFolder, poolIndex: idx },
        'Assigned and renamed pool bot',
      );
    } catch (err) {
      logger.warn(
        { sender, err },
        'Failed to rename pool bot (sending anyway)',
      );
    }
  }

  const api = poolApis[idx];
  try {
    const numericId = chatId.replace(/^tg:/, '');
    const MAX_LENGTH = 4096;
    if (text.length <= MAX_LENGTH) {
      await sendTelegramMessage(api, numericId, text, threadOpts);
    } else {
      for (let i = 0; i < text.length; i += MAX_LENGTH) {
        await sendTelegramMessage(
          api,
          numericId,
          text.slice(i, i + MAX_LENGTH),
          threadOpts,
        );
      }
    }
    logger.info(
      { chatId, sender, poolIndex: idx, length: text.length },
      'Pool message sent',
    );
  } catch (err) {
    logger.error({ chatId, sender, err }, 'Failed to send pool message');
  }
}

export class TelegramChannel implements Channel {
  name = 'telegram';

  private bot: Bot | null = null;
  private opts: TelegramChannelOpts;
  private botToken: string;

  constructor(botToken: string, opts: TelegramChannelOpts) {
    this.botToken = botToken;
    this.opts = opts;
  }

  async connect(): Promise<void> {
    this.bot = new Bot(this.botToken, {
      client: {
        baseFetchConfig: { agent: https.globalAgent, compress: true },
      },
    });

    // Command to get chat ID (useful for registration)
    this.bot.command('chatid', (ctx) => {
      const chatId = ctx.chat.id;
      const chatType = ctx.chat.type;
      const chatName =
        chatType === 'private'
          ? ctx.from?.first_name || 'Private'
          : (ctx.chat as any).title || 'Unknown';

      ctx.reply(
        `Chat ID: \`tg:${chatId}\`\nName: ${chatName}\nType: ${chatType}`,
        { parse_mode: 'Markdown' },
      );
    });

    // Command to check bot status
    this.bot.command('ping', (ctx) => {
      ctx.reply(`${ASSISTANT_NAME} is online.`);
    });

    // Command to clear recent chat messages.
    // Deletes up to 200 messages preceding /clear in batches of 100.
    // Bot must be an admin with "Delete messages" permission to remove
    // others' messages; without it, only the bot's own messages are deleted.
    this.bot.command('clear', async (ctx) => {
      const chatId = ctx.chat.id;
      const currentMsgId = ctx.message.message_id;
      const senderId = ctx.from?.id?.toString() ?? '';
      const chatJid = `tg:${chatId}`;

      // Only allow senders on the allowlist
      const allowlistCfg = loadSenderAllowlist();
      if (!isSenderAllowed(chatJid, senderId, allowlistCfg)) {
        logger.debug({ chatJid, senderId }, '/clear: sender not allowed');
        return;
      }

      // Delete the /clear command message itself
      await ctx.api.deleteMessage(chatId, currentMsgId).catch(() => {});

      // Delete up to 200 preceding messages in batches of 100
      const BATCH = 100;
      const LOOKBACK = 200;
      const start = Math.max(1, currentMsgId - LOOKBACK);

      for (let from = currentMsgId - 1; from >= start; from -= BATCH) {
        const ids: number[] = [];
        for (let id = from; id >= Math.max(start, from - BATCH + 1); id--) {
          ids.push(id);
        }
        // deleteMessages silently skips IDs that don't exist or can't be deleted
        await ctx.api.deleteMessages(chatId, ids).catch(() => {});
      }

      // Brief confirmation that self-deletes after 3 seconds
      const confirm = await ctx.reply('🗑️').catch(() => null);
      if (confirm) {
        setTimeout(() => {
          ctx.api.deleteMessage(chatId, confirm.message_id).catch(() => {});
        }, 3000);
      }
    });

    // Telegram bot commands handled above — skip them in the general handler
    // so they don't also get stored as messages. All other /commands flow through.
    const TELEGRAM_BOT_COMMANDS = new Set(['chatid', 'ping', 'clear']);

    this.bot.on('message:text', async (ctx) => {
      if (ctx.message.text.startsWith('/')) {
        const cmd = ctx.message.text.slice(1).split(/[\s@]/)[0].toLowerCase();
        if (TELEGRAM_BOT_COMMANDS.has(cmd)) return;
      }

      const chatJid = `tg:${ctx.chat.id}`;
      if (ctx.message.message_thread_id) {
        chatThreadId.set(chatJid, ctx.message.message_thread_id);
      }
      let content = ctx.message.text;
      const timestamp = new Date(ctx.message.date * 1000).toISOString();
      const senderName =
        ctx.from?.first_name ||
        ctx.from?.username ||
        ctx.from?.id.toString() ||
        'Unknown';
      const sender = ctx.from?.id.toString() || '';
      const msgId = ctx.message.message_id.toString();

      // Determine chat name
      const chatName =
        ctx.chat.type === 'private'
          ? senderName
          : (ctx.chat as any).title || chatJid;

      // Translate Telegram @bot_username mentions into TRIGGER_PATTERN format.
      // Telegram @mentions (e.g., @andy_ai_bot) won't match TRIGGER_PATTERN
      // (e.g., ^@Andy\b), so we prepend the trigger when the bot is @mentioned.
      const botUsername = ctx.me?.username?.toLowerCase();
      if (botUsername) {
        const entities = ctx.message.entities || [];
        const isBotMentioned = entities.some((entity) => {
          if (entity.type === 'mention') {
            const mentionText = content
              .substring(entity.offset, entity.offset + entity.length)
              .toLowerCase();
            return mentionText === `@${botUsername}`;
          }
          return false;
        });
        if (isBotMentioned && !TRIGGER_PATTERN.test(content)) {
          content = `@${ASSISTANT_NAME} ${content}`;
        }
      }

      // Store chat metadata for discovery
      const isGroup =
        ctx.chat.type === 'group' || ctx.chat.type === 'supergroup';
      this.opts.onChatMetadata(
        chatJid,
        timestamp,
        chatName,
        'telegram',
        isGroup,
      );

      // Only deliver full message for registered groups
      const group = this.opts.registeredGroups()[chatJid];
      if (!group) {
        logger.debug(
          { chatJid, chatName },
          'Message from unregistered Telegram chat',
        );
        return;
      }

      // Deliver message — startMessageLoop() will pick it up
      this.opts.onMessage(chatJid, {
        id: msgId,
        chat_jid: chatJid,
        sender,
        sender_name: senderName,
        content,
        timestamp,
        is_from_me: false,
      });

      logger.info(
        { chatJid, chatName, sender: senderName },
        'Telegram message stored',
      );
    });

    // Handle non-text messages with placeholders so the agent knows something was sent
    const storeNonText = (ctx: any, placeholder: string) => {
      const chatJid = `tg:${ctx.chat.id}`;
      if (ctx.message?.message_thread_id) {
        chatThreadId.set(chatJid, ctx.message.message_thread_id);
      }
      const group = this.opts.registeredGroups()[chatJid];
      if (!group) return;

      const timestamp = new Date(ctx.message.date * 1000).toISOString();
      const senderName =
        ctx.from?.first_name ||
        ctx.from?.username ||
        ctx.from?.id?.toString() ||
        'Unknown';
      const caption = ctx.message.caption ? ` ${ctx.message.caption}` : '';

      const isGroup =
        ctx.chat.type === 'group' || ctx.chat.type === 'supergroup';
      this.opts.onChatMetadata(
        chatJid,
        timestamp,
        undefined,
        'telegram',
        isGroup,
      );
      this.opts.onMessage(chatJid, {
        id: ctx.message.message_id.toString(),
        chat_jid: chatJid,
        sender: ctx.from?.id?.toString() || '',
        sender_name: senderName,
        content: `${placeholder}${caption}`,
        timestamp,
        is_from_me: false,
      });
    };

    this.bot.on('message:photo', async (ctx) => {
      const chatJid = `tg:${ctx.chat.id}`;
      const group = this.opts.registeredGroups()[chatJid];
      if (!group) return;

      try {
        // Get the largest photo (last in array)
        const photos = ctx.message.photo;
        const largest = photos[photos.length - 1];
        const file = await ctx.api.getFile(largest.file_id);
        const fileUrl = `https://api.telegram.org/file/bot${this.botToken}/${file.file_path}`;

        // Download the image
        const buffer = await new Promise<Buffer>((resolve, reject) => {
          https
            .get(fileUrl, (res) => {
              const chunks: Buffer[] = [];
              res.on('data', (chunk) => chunks.push(chunk));
              res.on('end', () => resolve(Buffer.concat(chunks)));
              res.on('error', reject);
            })
            .on('error', reject);
        });

        const groupDir = resolveGroupFolderPath(group.folder);
        const caption = ctx.message.caption || '';
        const processed = await processImage(buffer, groupDir, caption);

        if (processed) {
          const timestamp = new Date(ctx.message.date * 1000).toISOString();
          const senderName =
            ctx.from?.first_name || ctx.from?.username || 'Unknown';
          const isGroup =
            ctx.chat.type === 'group' || ctx.chat.type === 'supergroup';

          this.opts.onChatMetadata(
            chatJid,
            timestamp,
            undefined,
            'telegram',
            isGroup,
          );
          this.opts.onMessage(chatJid, {
            id: ctx.message.message_id.toString(),
            chat_jid: chatJid,
            sender: ctx.from?.id?.toString() || '',
            sender_name: senderName,
            content: processed.content,
            timestamp,
            is_from_me: false,
          });
          logger.info(
            { chatJid, image: processed.relativePath },
            'Telegram image processed',
          );
        }
      } catch (err) {
        logger.error({ chatJid, err }, 'Failed to process Telegram image');
        storeNonText(ctx, '[Photo]');
      }
    });
    this.bot.on('message:video', (ctx) => storeNonText(ctx, '[Video]'));
    this.bot.on('message:voice', async (ctx) => {
      const chatJid = `tg:${ctx.chat.id}`;
      const group = this.opts.registeredGroups()[chatJid];
      if (!group) return;

      try {
        const file = await ctx.api.getFile(ctx.message.voice.file_id);
        const fileUrl = `https://api.telegram.org/file/bot${this.botToken}/${file.file_path}`;

        const buffer = await new Promise<Buffer>((resolve, reject) => {
          https
            .get(fileUrl, (res) => {
              const chunks: Buffer[] = [];
              res.on('data', (chunk) => chunks.push(chunk));
              res.on('end', () => resolve(Buffer.concat(chunks)));
              res.on('error', reject);
            })
            .on('error', reject);
        });

        const transcript = await transcribeBuffer(buffer);
        const content = transcript
          ? `[Voice: ${transcript}]`
          : '[Voice Message - transcription unavailable]';

        logger.info(
          { chatJid, length: transcript?.length ?? 0 },
          'Transcribed Telegram voice message',
        );

        const timestamp = new Date(ctx.message.date * 1000).toISOString();
        const senderName =
          ctx.from?.first_name || ctx.from?.username || 'Unknown';
        const isGroup =
          ctx.chat.type === 'group' || ctx.chat.type === 'supergroup';

        this.opts.onChatMetadata(
          chatJid,
          timestamp,
          undefined,
          'telegram',
          isGroup,
        );
        this.opts.onMessage(chatJid, {
          id: ctx.message.message_id.toString(),
          chat_jid: chatJid,
          sender: ctx.from?.id?.toString() || '',
          sender_name: senderName,
          content,
          timestamp,
          is_from_me: false,
        });
      } catch (err) {
        logger.error(
          { chatJid, err },
          'Failed to transcribe Telegram voice message',
        );
        storeNonText(ctx, '[Voice message]');
      }
    });
    this.bot.on('message:audio', (ctx) => storeNonText(ctx, '[Audio]'));
    this.bot.on('message:document', async (ctx) => {
      const chatJid = `tg:${ctx.chat.id}`;
      const group = this.opts.registeredGroups()[chatJid];
      if (!group) return;

      const doc = ctx.message.document;
      const displayName = doc?.file_name || 'file';
      const isPdf =
        doc?.mime_type === 'application/pdf' ||
        displayName.toLowerCase().endsWith('.pdf');

      if (!isPdf) {
        storeNonText(ctx, `[Document: ${displayName}]`);
        return;
      }

      try {
        const file = await ctx.api.getFile(doc.file_id);
        const fileUrl = `https://api.telegram.org/file/bot${this.botToken}/${file.file_path}`;

        const buffer = await new Promise<Buffer>((resolve, reject) => {
          https
            .get(fileUrl, (res) => {
              const chunks: Buffer[] = [];
              res.on('data', (chunk) => chunks.push(chunk));
              res.on('end', () => resolve(Buffer.concat(chunks)));
              res.on('error', reject);
            })
            .on('error', reject);
        });

        const groupDir = resolveGroupFolderPath(group.folder);
        const attachDir = path.join(groupDir, 'attachments');
        fs.mkdirSync(attachDir, { recursive: true });
        const safeName = path.basename(
          doc?.file_name || `doc-${Date.now()}.pdf`,
        );
        const filePath = path.join(attachDir, safeName);
        fs.writeFileSync(filePath, buffer);

        const sizeKB = Math.round(buffer.length / 1024);
        const caption = ctx.message.caption || '';
        const pdfRef = `[PDF: attachments/${safeName} (${sizeKB}KB)]\nUse: pdf-reader extract attachments/${safeName}`;
        const content = caption ? `${caption}\n\n${pdfRef}` : pdfRef;

        logger.info({ chatJid, filename: safeName }, 'Downloaded Telegram PDF');

        const timestamp = new Date(ctx.message.date * 1000).toISOString();
        const senderName =
          ctx.from?.first_name || ctx.from?.username || 'Unknown';
        const isGroup =
          ctx.chat.type === 'group' || ctx.chat.type === 'supergroup';

        this.opts.onChatMetadata(
          chatJid,
          timestamp,
          undefined,
          'telegram',
          isGroup,
        );
        this.opts.onMessage(chatJid, {
          id: ctx.message.message_id.toString(),
          chat_jid: chatJid,
          sender: ctx.from?.id?.toString() || '',
          sender_name: senderName,
          content,
          timestamp,
          is_from_me: false,
        });
      } catch (err) {
        logger.error({ chatJid, err }, 'Failed to download Telegram PDF');
        storeNonText(ctx, `[Document: ${displayName}]`);
      }
    });
    this.bot.on('message:sticker', (ctx) => {
      const emoji = ctx.message.sticker?.emoji || '';
      storeNonText(ctx, `[Sticker ${emoji}]`);
    });
    this.bot.on('message:location', (ctx) => storeNonText(ctx, '[Location]'));
    this.bot.on('message:contact', (ctx) => storeNonText(ctx, '[Contact]'));

    // Handle errors gracefully
    this.bot.catch((err) => {
      logger.error({ err: err.message }, 'Telegram bot error');
    });

    // Store reference for pool fallback
    mainBotApi = this.bot.api;

    // Start polling — returns a Promise that resolves when started
    return new Promise<void>((resolve) => {
      this.bot!.start({
        onStart: (botInfo) => {
          logger.info(
            { username: botInfo.username, id: botInfo.id },
            'Telegram bot connected',
          );
          console.log(`\n  Telegram bot: @${botInfo.username}`);
          console.log(
            `  Send /chatid to the bot to get a chat's registration ID\n`,
          );
          resolve();
        },
      });
    });
  }

  async sendMessage(
    jid: string,
    text: string,
    threadId?: number,
  ): Promise<void> {
    if (!this.bot) {
      logger.warn('Telegram bot not initialized');
      return;
    }

    try {
      const numericId = jid.replace(/^tg:/, '');
      const threadOpts = threadId
        ? { message_thread_id: threadId }
        : chatThreadId.has(jid)
          ? { message_thread_id: chatThreadId.get(jid)! }
          : {};

      // Telegram has a 4096 character limit per message — split if needed
      const MAX_LENGTH = 4096;
      if (text.length <= MAX_LENGTH) {
        await sendTelegramMessage(this.bot.api, numericId, text, threadOpts);
      } else {
        for (let i = 0; i < text.length; i += MAX_LENGTH) {
          await sendTelegramMessage(
            this.bot.api,
            numericId,
            text.slice(i, i + MAX_LENGTH),
            threadOpts,
          );
        }
      }
      logger.info({ jid, length: text.length }, 'Telegram message sent');
    } catch (err) {
      logger.error({ jid, err }, 'Failed to send Telegram message');
    }
  }

  isConnected(): boolean {
    return this.bot !== null;
  }

  ownsJid(jid: string): boolean {
    return jid.startsWith('tg:');
  }

  async disconnect(): Promise<void> {
    if (this.bot) {
      this.bot.stop();
      this.bot = null;
      logger.info('Telegram bot stopped');
    }
  }

  async setTyping(jid: string, isTyping: boolean): Promise<void> {
    if (!this.bot || !isTyping) return;
    try {
      const numericId = jid.replace(/^tg:/, '');
      const threadId = chatThreadId.get(jid);
      await this.bot.api.sendChatAction(numericId, 'typing', {
        ...(threadId ? { message_thread_id: threadId } : {}),
      });
    } catch (err) {
      logger.debug({ jid, err }, 'Failed to send Telegram typing indicator');
    }
  }
}

registerChannel('telegram', (opts: ChannelOpts) => {
  const envVars = readEnvFile(['TELEGRAM_BOT_TOKEN']);
  const token =
    process.env.TELEGRAM_BOT_TOKEN || envVars.TELEGRAM_BOT_TOKEN || '';
  if (!token) {
    logger.warn('Telegram: TELEGRAM_BOT_TOKEN not set');
    return null;
  }
  return new TelegramChannel(token, opts);
});


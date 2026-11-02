import { isMac, userHome, resolveCodex, codexCommand, loadLocalConfig, localConfigPath, discoverSkills, resolveChatSkill, skillContext, validSignature, PrivateTasks } from './portable.js';
import { createServer } from "node:http";
import { HubCommands, isHubCommand } from './hub-commands.js';
import { memoryScope } from './unified-memory/index.js';
import { RecentImages } from './recent-images.js';
import { MoodState, stripMoodMarkers } from './mood-state.js';
import { MessageBatches } from './message-batches.js';
import { replyTimingContext, createReplyTiming, measureModelCall, measurePreparation, measureSend } from './reply-timing.js';
import { classifyCliFailure, publicFailure } from './cli-errors.js';
import { runCliProcess } from './cli-process.js';
import { assertProxyReachable } from './proxy-control.js';
import { createWorld, createWorldHttp } from './world.js';
import { createWorldModel } from './world-model.js';
import { loadAssistantProfile } from './assistant-profile.js';
import { createServiceLifecycle } from './service-lifecycle.js';
import { createLifeTimeline } from './life-timeline.js';
import { createLifeReplies } from './life-replies.js';
import { createLifeContacts, isExplicitContactStop, ownContactEvidence, isExplicitContactInvitation } from './life-contacts.js';
import { createLifePlanner } from './life-planner.js';
import { createLifeBrowsing } from './life-browsing.js';
import { createLifeProactive, proactiveDecisionSchema, buildProactivePrompt } from './life-proactive.js';
import { lifeChatDecisionSchema, parseLifeChatDecision, lifeChatDecisionPrompt } from './life-chat-decision.js';
import { createLifeConversation, conversationDecisionSchema, buildConversationPrompt } from './life-conversation.js';
import { createLifeState } from './life-state.js';
import { createLifeObserverHttp } from './life-observer-http.js';
import { createConfiguredRuntimeBudget } from './runtime-budget-service.js';
import { ensureStickerLeadText, sendTextThenSticker, inReplyOrder } from './sticker-replies.js';
const recentImages = new RecentImages();
// Successful deliveries provide recipient provenance when a bridge omits
// target_id on a later bot-authored quotation. Bound the in-process cache.
const privateDeliveryRecipients = new Map();
import { spawn } from "node:child_process";
import { access, mkdir, readFile, readdir, stat, writeFile, appendFile, rename } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { brotliDecompressSync } from "node:zlib";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const projectDir = join(__dirname, "..");
// Private chat is the product boundary; legacy configuration cannot re-enable groups.
const localConfig = { ...loadLocalConfig(projectDir), qqPrivateOnly: true };
const runtimeBudget = await createConfiguredRuntimeBudget({ projectDir, config: localConfig });
let serviceLifecycle = null;
let lifeTimeline = null, lifeReplies = null, lifeContacts = null, lifePlanner = null, personalLifeState = null, lifeTimer = null;
let lifeBrowsing = null, lifeProactive = null, lifeActionsPending = false;
let lifeConversation = null, lifeConversationPending = false;
let lifeTickPending = false, lifeDrainPending = false, lifePlanningPending = false;
const lifeWarningsSeen = new Set();
let activeHttpRequests = 0, activeBackgroundTasks = 0, activeCliProcesses = 0;
let persistenceFailed = false;
function backgroundTask(task) {
  activeBackgroundTasks++;
  return Promise.resolve(task).finally(() => { activeBackgroundTasks--; });
}
const installedSkills = discoverSkills(projectDir, localConfig);
const oneBotSecret = process.env.ONEBOT_SECRET || localConfig.oneBotSecret || '';
const oneBotToken = process.env.ONEBOT_ACCESS_TOKEN || localConfig.oneBotAccessToken || '';
const privateTasks = new PrivateTasks({
  skills: installedSkills,
  allowFullAccess: localConfig.allowFullAccessTasks === true,
  enabled: Boolean(localConfig.remoteEnabled && oneBotSecret && localConfig.ownerUserIds?.length),
  run: runPrivateTask
});
const publicDir = join(projectDir, "modules", "web-console", "public");
const codexWorkspaceDir = join(projectDir, "workspaces", "codex-cli");
const codexTmpDir = join(projectDir, "runtime", "replies");
const imessageScreenshotsDir = join(projectDir, "runtime", "imessage-screenshots");
const qqStickerDir = process.env.CODEX_REMOTE_CONTACT_QQ_STICKER_DIR || join(projectDir, "data", "qq-stickers");
const dataDir = join(projectDir, "data");
const codexHomeDir = process.env.CODEX_HOME || join(userHome, ".codex");
const codexSessionsDir = join(codexHomeDir, "sessions");
const codexArchivedSessionsDir = join(codexHomeDir, "archived_sessions");
const codexLogsDbPath = join(codexHomeDir, "logs_2.sqlite");
const codexStateDbPath = join(codexHomeDir, "state_5.sqlite");
const codexDesktopCacheDir = join(userHome, "Library", "Application Support", "Codex", "Cache", "Cache_Data");
const settingsPath = join(dataDir, "settings.json");
const imessageMemoryPath = join(dataDir, "imessage-memory.json");
const remoteExecutionMemoryPath = join(dataDir, "remote-execution-memory.json");
const unifiedMemoryPath = join(dataDir, "unified-memory.json");
const shadowrocketNodeControlPath = join(projectDir, "modules", "shadowrocket", "shadowrocket-node-control.command");
const backlightOffScriptPath = join(projectDir, "modules", "system-control", "backlight-off-keep-awake.command");
const backlightRestoreScriptPath = join(projectDir, "modules", "system-control", "backlight-restore.command");

function fallbackMemoryStore() {
  return {
    async read() {
      return { entries: [], disabled: true, reason: "unified-memory module is not installed" };
    },
    async status() {
      return { ok: true, enabled: false, count: 0, reason: "unified-memory module is not installed" };
    },
    async write() {
      return { ok: false, skipped: true, reason: "unified-memory module is not installed" };
    },
    async writeExchange() {
      return { ok: false, skipped: true, reason: "unified-memory module is not installed" };
    },
    async recall() {
      return { context: '', entries: [], evidenceKeys: [], hasNewEvidence: false };
    },
    async hasDeliveredMessage() { return false; },
    async formatPrivateProfile() { return ''; },
    async clear() {
      return { ok: false, skipped: true, reason: "unified-memory module is not installed" };
    },
    async formatForPrompt() {
      return "";
    }
  };
}

let buildUnifiedMemoryJudgePrompt = () => "";
let createUnifiedMemory = () => fallbackMemoryStore();
let judgeUnifiedMemoryByRules = () => ({ action: "none", reason: "unified-memory module is not installed" });
let parseUnifiedMemoryJudge = () => ({ action: "none", reason: "unified-memory module is not installed" });
let formatRecentContextPrompt = () => "";
let searchRecentCodexContext = async () => [];

let buildQqChatStyleInstructions = () => "";
let buildQqReplyWorkspaceStyleInstructions = () => [];
let buildQqStickerCatalog = async () => [];
let buildQqImageSegment = (filePath) => ({ type: "image", data: { file: `file://${filePath}` } });
let extractOneBotImageInputs = () => [];
let formatQqImageSummary = () => "";
let formatQqStickerCatalog = () => "";
let prepareQqModelImages = async () => [];
let qqVisionAvailable = false;
let resolveQqReplyMedia = async () => [];
let stripQqImageAttachmentMarkers = (text) => String(text || "").trim();

async function importOptionalModule(label, candidates) {
  for (const candidate of candidates.filter(Boolean)) {
    try {
      const specifier = candidate.startsWith("file:") || candidate.startsWith(".")
        ? candidate
        : pathToFileURL(candidate).href;
      return await import(specifier);
    } catch (error) {
      if (error?.code && !["ERR_MODULE_NOT_FOUND", "ERR_INVALID_FILE_URL_PATH", "ERR_UNSUPPORTED_ESM_URL_SCHEME"].includes(error.code)) {
        console.warn(`${label} failed to load from ${candidate}: ${error.message}`);
      }
    }
  }
  console.warn(`${label} not installed; continuing with built-in fallback.`);
  return null;
}

const unifiedMemoryModule = await importOptionalModule("unified-memory", [
  process.env.CODEX_REMOTE_CONTACT_UNIFIED_MEMORY_MODULE,
  new URL("./unified-memory/index.js", import.meta.url).href,
  pathToFileURL(join(projectDir, "modules", "unified-memory", "index.js")).href,
  pathToFileURL(join(projectDir, "..", "unified-memory", "src", "unified-memory", "index.js")).href
]);
if (unifiedMemoryModule) {
  buildUnifiedMemoryJudgePrompt = unifiedMemoryModule.buildUnifiedMemoryJudgePrompt || buildUnifiedMemoryJudgePrompt;
  createUnifiedMemory = unifiedMemoryModule.createUnifiedMemory || createUnifiedMemory;
  judgeUnifiedMemoryByRules = unifiedMemoryModule.judgeUnifiedMemoryByRules || judgeUnifiedMemoryByRules;
  parseUnifiedMemoryJudge = unifiedMemoryModule.parseUnifiedMemoryJudge || parseUnifiedMemoryJudge;
}

const recentContextModule = await importOptionalModule("unified-memory recent context", [
  process.env.CODEX_REMOTE_CONTACT_RECENT_CONTEXT_MODULE,
  new URL("./unified-memory/recent-context.js", import.meta.url).href,
  pathToFileURL(join(projectDir, "modules", "unified-memory", "recent-context.js")).href,
  pathToFileURL(join(projectDir, "..", "unified-memory", "src", "unified-memory", "recent-context.js")).href
]);
if (recentContextModule) {
  formatRecentContextPrompt = recentContextModule.formatRecentContextPrompt || formatRecentContextPrompt;
  searchRecentCodexContext = recentContextModule.searchRecentCodexContext || searchRecentCodexContext;
}

const qqEnhancerModule = await importOptionalModule("qq-enhancer", [
  process.env.CODEX_REMOTE_CONTACT_QQ_ENHANCER_MODULE,
  new URL("./qq-enhancer/index.js", import.meta.url).href,
  pathToFileURL(join(projectDir, "modules", "qq-enhancer", "index.js")).href,
  pathToFileURL(join(projectDir, "..", "qq-enhancer", "src", "qq-enhancer", "index.js")).href
]);
if (qqEnhancerModule) {
  buildQqChatStyleInstructions = qqEnhancerModule.buildQqChatStyleInstructions || buildQqChatStyleInstructions;
  buildQqReplyWorkspaceStyleInstructions = qqEnhancerModule.buildQqReplyWorkspaceStyleInstructions || buildQqReplyWorkspaceStyleInstructions;
  buildQqStickerCatalog = qqEnhancerModule.buildQqStickerCatalog || buildQqStickerCatalog;
  buildQqImageSegment = qqEnhancerModule.buildQqImageSegment || buildQqImageSegment;
  extractOneBotImageInputs = qqEnhancerModule.extractOneBotImageInputs || extractOneBotImageInputs;
  formatQqImageSummary = qqEnhancerModule.formatQqImageSummary || formatQqImageSummary;
  formatQqStickerCatalog = qqEnhancerModule.formatQqStickerCatalog || formatQqStickerCatalog;
  prepareQqModelImages = qqEnhancerModule.prepareQqModelImages || prepareQqModelImages;
  qqVisionAvailable = Boolean(qqEnhancerModule.extractOneBotImageInputs && qqEnhancerModule.prepareQqModelImages);
  resolveQqReplyMedia = qqEnhancerModule.resolveQqReplyMedia || resolveQqReplyMedia;
  stripQqImageAttachmentMarkers = qqEnhancerModule.stripQqImageAttachmentMarkers || stripQqImageAttachmentMarkers;
}

const oneBotApiBase = process.env.ONEBOT_API_BASE || localConfig.oneBotApiBase || "http://127.0.0.1:3000";
const codexCliPath = resolveCodex();
const codexModel = process.env.CODEX_REMOTE_CONTACT_CODEX_MODEL || localConfig.chatModel || (isMac ? "gpt-5.4-mini" : "default");
const codexReasoningEffort = process.env.CODEX_REMOTE_CONTACT_REASONING_EFFORT || "low";
const imessageCodexModel = process.env.CODEX_REMOTE_CONTACT_IMESSAGE_CODEX_MODEL || "gpt-5.4";
const imessageCodexReasoningEffort = process.env.CODEX_REMOTE_CONTACT_IMESSAGE_REASONING_EFFORT || "medium";
const qqEnhancerEnabled = process.env.CODEX_REMOTE_CONTACT_QQ_ENHANCER !== "0";
const imessageMemoryLimit = Number(process.env.CODEX_REMOTE_CONTACT_IMESSAGE_MEMORY_LIMIT || 120);
const remoteExecutionMemoryLimit = Number(process.env.CODEX_REMOTE_CONTACT_REMOTE_EXECUTION_MEMORY_LIMIT || 160);
const remoteExecutionIdleTtlMs = Number(process.env.CODEX_REMOTE_CONTACT_REMOTE_EXECUTION_IDLE_TTL_MS || 15 * 60 * 1000);
const qqWebLookupEnabled = process.env.CODEX_REMOTE_CONTACT_QQ_WEB_LOOKUP != null ? process.env.CODEX_REMOTE_CONTACT_QQ_WEB_LOOKUP !== "0" : localConfig.webLookup !== false;
const qqWebLookupTimeoutMs = Number(process.env.CODEX_REMOTE_CONTACT_QQ_WEB_TIMEOUT_MS || 12000);
const qqWebSearchProvider = String(process.env.CODEX_REMOTE_CONTACT_QQ_WEB_PROVIDER || "auto").trim().toLowerCase();
const proxyShortcutName = process.env.CODEX_REMOTE_CONTACT_PROXY_TOGGLE_SHORTCUT || "切换VPN";
const proxyConfirmTtlMs = Number(process.env.CODEX_REMOTE_CONTACT_PROXY_CONFIRM_TTL_MS || 3 * 60 * 1000);
const imessageAttachmentSendingEnabled = process.env.CODEX_REMOTE_CONTACT_IMESSAGE_ATTACHMENTS === "1";
const imessageImageDelivery = process.env.CODEX_REMOTE_CONTACT_IMESSAGE_IMAGE_DELIVERY || (imessageAttachmentSendingEnabled ? "attachment" : "photos");
// Deployment customization: set these in data/settings.json -> branding,
// or via environment variables, to give the bot a public name and owner label.
let assistantName = process.env.CODEX_REMOTE_CONTACT_ASSISTANT_NAME || "assistant";
let ownerLabel = process.env.CODEX_REMOTE_CONTACT_OWNER_LABEL || "管理员";
let userAgentName = process.env.CODEX_REMOTE_CONTACT_USER_AGENT || "codexremotecontact/0.1";
let assistantMentionAliases = (process.env.CODEX_REMOTE_CONTACT_ASSISTANT_MENTIONS || "@assistant")
  .split(",")
  .map((item) => item.trim())
  .filter(Boolean);
const unifiedMemory = createUnifiedMemory({ memoryPath: unifiedMemoryPath });
const moodState = new MoodState({ memory: unifiedMemory, enabled: localConfig.mood?.enabled === true });

const state = {
  ai: {
    provider: "codex-cli",
    model: codexModel || "default",
    reasoningEffort: codexReasoningEffort,
    imessageModel: imessageCodexModel,
    imessageReasoningEffort: imessageCodexReasoningEffort,
    workspace: codexWorkspaceDir
  },
  channels: {
    qq: Boolean(localConfig.qqEnabled),
    imessage: isMac
  },
  qq: {
    ownerUserIds: [],
    bannedUserIds: [],
    enhancer: {
      enabled: qqEnhancerEnabled
    },
    webLookup: {
      enabled: qqWebLookupEnabled
    },
    events: []
  },
  imessage: {
    trustedHandles: [],
    replyHandle: "",
    lastRowId: 0,
    cursorReady: false,
    watchStartedAtAppleDate: 0,
    status: "idle",
    lastError: null,
    events: [],
    memory: {
      perHandleLimit: imessageMemoryLimit,
      entries: {}
    }
  },
  proxy: {
    pendingAction: null
  },
  unifiedMemory: {
    autoWriteOnSkillRecall: false,
    autoWriteOnIMessageRecall: true,
    manualHandoffCommand: true
  },
  unifiedMemoryPendingClear: null,
  remoteExecution: {
    enabled: false,
    pendingAction: null,
    model: process.env.CODEX_REMOTE_CONTACT_REMOTE_EXECUTION_MODEL || imessageCodexModel,
    reasoningEffort: process.env.CODEX_REMOTE_CONTACT_REMOTE_EXECUTION_REASONING_EFFORT || imessageCodexReasoningEffort,
    skill: process.env.CODEX_REMOTE_CONTACT_REMOTE_EXECUTION_SKILL || "none",
    idleTtlMs: remoteExecutionIdleTtlMs,
    lastActivityAt: null,
    busy: false,
    memory: {
      limit: remoteExecutionMemoryLimit,
      entries: []
    }
  },
  maintenance: {
    startedAt: new Date().toISOString(),
    oneBot: {
      ok: false,
      lastCheckedAt: null,
      lastError: null,
      selfId: null,
      nickname: null
    },
    codex: {
      path: codexCliPath,
      lastRunAt: null,
      lastDurationMs: null,
      lastOk: null,
      lastError: null,
      quota: null
    },
    webLookup: {
      enabled: qqWebLookupEnabled,
      effectiveProvider: null,
      lastQuery: null,
      lastRunAt: null,
      lastDurationMs: null,
      lastOk: null,
      lastError: null
    }
  }
};

const seenOneBotMessageIds = new Map();
const seenMessageTtlMs = 10 * 60 * 1000;
let imessagePollTimer = null;
let remoteExecutionIdleTimer = null;
let imessagePolling = false;
const seenIMessageGuids = new Map();
const recentIMessageReplies = new Map();
const recentIMessageRequests = new Map();
const imessageReplyEchoTtlMs = 5 * 60 * 1000;
const imessageSeenTtlMs = 30 * 60 * 1000;
const imessageRequestDedupeTtlMs = 45 * 1000;
const imessageStartupGraceMs = 10 * 1000;
const appleDateEpochMs = Date.UTC(2001, 0, 1);

const mimeTypes = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8"
};

function sendJson(res, code, body) {
  res.writeHead(code, {
    "content-type": "application/json; charset=utf-8",
    ...corsHeaders()
  });
  res.end(JSON.stringify(body, null, 2));
}

function corsHeaders() {
  return {
    "vary": "Origin",
    "access-control-allow-methods": "GET,POST,OPTIONS",
    "access-control-allow-headers": "content-type"
  };
}

async function readBody(req) {
  if (req.body !== undefined) return req.body;
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 1024 * 1024) throw new Error('Request exceeds 1 MiB');
    chunks.push(chunk);
  }
  if (chunks.length === 0) return {};
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

async function loadSettings() {
  await mkdir(dataDir, { recursive: true });
  try {
    const body = JSON.parse(await readFile(settingsPath, "utf8"));
    if (Array.isArray(body.qq?.ownerUserIds)) {
      state.qq.ownerUserIds = normalizeList(body.qq.ownerUserIds);
    }
    if (Array.isArray(body.qq?.bannedUserIds)) {
      state.qq.bannedUserIds = normalizeList(body.qq.bannedUserIds);
    }
    if (body.qq?.enhancer && typeof body.qq.enhancer === "object") {
      state.qq.enhancer.enabled = body.qq.enhancer.enabled !== false;
    }
    if (Array.isArray(body.imessage?.trustedHandles)) {
      state.imessage.trustedHandles = normalizeList(body.imessage.trustedHandles);
    }
    if (typeof body.imessage?.replyHandle === "string") {
      state.imessage.replyHandle = body.imessage.replyHandle.trim();
    }
    const remoteExecutionConfig = body.remoteExecution && typeof body.remoteExecution === "object"
      ? body.remoteExecution
      : null;
    if (remoteExecutionConfig) {
      if (typeof remoteExecutionConfig.model === "string" && remoteExecutionConfig.model.trim()) {
        state.remoteExecution.model = remoteExecutionConfig.model.trim();
      }
      if (isValidReasoningEffort(remoteExecutionConfig.reasoningEffort)) {
        state.remoteExecution.reasoningEffort = remoteExecutionConfig.reasoningEffort;
      }
      if (isValidRemoteExecutionSkill(remoteExecutionConfig.skill)) {
        state.remoteExecution.skill = remoteExecutionConfig.skill;
      }
    }
    if (body.ai && typeof body.ai === "object") {
      if (typeof body.ai.model === "string" && body.ai.model.trim()) {
        state.ai.model = body.ai.model.trim();
      }
      if (isValidReasoningEffort(body.ai.reasoningEffort)) {
        state.ai.reasoningEffort = body.ai.reasoningEffort;
      }
      if (typeof body.ai.imessageModel === "string" && body.ai.imessageModel.trim()) {
        state.ai.imessageModel = body.ai.imessageModel.trim();
      }
      if (isValidReasoningEffort(body.ai.imessageReasoningEffort)) {
        state.ai.imessageReasoningEffort = body.ai.imessageReasoningEffort;
      }
    }
    if (body.unifiedMemory && typeof body.unifiedMemory === "object") {
      state.unifiedMemory.autoWriteOnSkillRecall = Boolean(body.unifiedMemory.autoWriteOnSkillRecall);
      state.unifiedMemory.autoWriteOnIMessageRecall = body.unifiedMemory.autoWriteOnIMessageRecall !== false;
      state.unifiedMemory.manualHandoffCommand = body.unifiedMemory.manualHandoffCommand !== false;
    }
    if (body.branding && typeof body.branding === "object") {
      if (typeof body.branding.assistantName === "string" && body.branding.assistantName.trim()) {
        assistantName = body.branding.assistantName.trim();
      }
      if (typeof body.branding.ownerLabel === "string" && body.branding.ownerLabel.trim()) {
        ownerLabel = body.branding.ownerLabel.trim();
      }
      if (typeof body.branding.userAgent === "string" && body.branding.userAgent.trim()) {
        userAgentName = body.branding.userAgent.trim();
      }
      if (Array.isArray(body.branding.assistantMentions)) {
        assistantMentionAliases = normalizeList(body.branding.assistantMentions);
      }
    }
  } catch (error) {
    if (error.code !== "ENOENT") {
      console.warn(`Unable to load settings: ${error.message}`);
    }
  }
}

async function saveSettings() {
  await mkdir(dataDir, { recursive: true });
  await writeFile(
    settingsPath,
    JSON.stringify({
      version: 1,
      updatedAt: new Date().toISOString(),
      ai: {
        model: state.ai.model,
        reasoningEffort: state.ai.reasoningEffort,
        imessageModel: state.ai.imessageModel,
        imessageReasoningEffort: state.ai.imessageReasoningEffort
      },
      qq: {
        ownerUserIds: state.qq.ownerUserIds,
        bannedUserIds: state.qq.bannedUserIds,
        enhancer: {
          enabled: state.qq.enhancer.enabled
        }
      },
      imessage: {
        trustedHandles: state.imessage.trustedHandles,
        replyHandle: state.imessage.replyHandle
      },
      remoteExecution: {
        model: state.remoteExecution.model,
        reasoningEffort: state.remoteExecution.reasoningEffort,
        skill: state.remoteExecution.skill
      },
      unifiedMemory: {
        autoWriteOnSkillRecall: state.unifiedMemory.autoWriteOnSkillRecall,
        autoWriteOnIMessageRecall: state.unifiedMemory.autoWriteOnIMessageRecall,
        manualHandoffCommand: state.unifiedMemory.manualHandoffCommand
      },
      branding: {
        assistantName,
        ownerLabel,
        userAgent: userAgentName,
        assistantMentions: assistantMentionAliases
      }
    }, null, 2)
  );
}

function isValidReasoningEffort(value) {
  return ["low", "medium", "high", "xhigh"].includes(String(value || ""));
}

function getRemoteExecutionSkillRegistry() {
  return Object.fromEntries(
    String(process.env.CODEX_REMOTE_CONTACT_SKILL_PATHS || "")
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean)
      .map((item) => {
        const [name, ...pathParts] = item.split("=");
        return [name.trim(), pathParts.join("=").trim()];
      })
      .filter(([name, path]) => name && path)
  );
}

function isValidRemoteExecutionSkill(value) {
  const skill = String(value || "").trim();
  return skill === "none" || Object.prototype.hasOwnProperty.call(getRemoteExecutionSkillRegistry(), skill);
}

function normalizeList(items) {
  return [...new Set(
    items
      .map((item) => String(item).trim())
      .filter(Boolean)
  )];
}

async function loadIMessageMemory() {
  await mkdir(dataDir, { recursive: true });
  try {
    const body = JSON.parse(await readFile(imessageMemoryPath, "utf8"));
    if (body && typeof body === "object" && body.entries && typeof body.entries === "object") {
      state.imessage.memory.entries = body.entries;
    }
  } catch (error) {
    if (error.code !== "ENOENT") {
      console.warn(`Unable to load iMessage memory: ${error.message}`);
    }
  }
}

async function saveIMessageMemory() {
  await mkdir(dataDir, { recursive: true });
  await writeFile(
    imessageMemoryPath,
    JSON.stringify({
      version: 1,
      updatedAt: new Date().toISOString(),
      perHandleLimit: state.imessage.memory.perHandleLimit,
      entries: state.imessage.memory.entries
    }, null, 2)
  );
}

async function loadRemoteExecutionMemory() {
  await mkdir(dataDir, { recursive: true });
  try {
    const body = JSON.parse(await readFile(remoteExecutionMemoryPath, "utf8"));
    if (body && typeof body === "object" && Array.isArray(body.entries)) {
      state.remoteExecution.memory.entries = body.entries;
    }
  } catch (error) {
    if (error.code !== "ENOENT") {
      console.warn(`Unable to load remote execution memory: ${error.message}`);
    }
  }
}

async function saveRemoteExecutionMemory() {
  await mkdir(dataDir, { recursive: true });
  await writeFile(
    remoteExecutionMemoryPath,
    JSON.stringify({
      version: 1,
      updatedAt: new Date().toISOString(),
      limit: state.remoteExecution.memory.limit,
      entries: state.remoteExecution.memory.entries
    }, null, 2)
  );
}

function buildPublicState() {
  return {
    ...state,
    imessage: {
      trustedHandles: state.imessage.trustedHandles,
      replyHandle: state.imessage.replyHandle,
      lastRowId: state.imessage.lastRowId,
      status: state.imessage.status,
      lastError: state.imessage.lastError,
      events: state.imessage.events,
      memory: {
        perHandleLimit: state.imessage.memory.perHandleLimit,
        handleCounts: Object.fromEntries(
          Object.entries(state.imessage.memory.entries).map(([handle, entries]) => [handle, Array.isArray(entries) ? entries.length : 0])
        )
      }
    },
    remoteExecution: {
      enabled: state.remoteExecution.enabled,
      model: state.remoteExecution.model,
      reasoningEffort: state.remoteExecution.reasoningEffort,
      skill: state.remoteExecution.skill,
      idleTtlMs: state.remoteExecution.idleTtlMs,
      lastActivityAt: state.remoteExecution.lastActivityAt,
      busy: state.remoteExecution.busy,
      pendingAction: state.remoteExecution.pendingAction ? {
        action: state.remoteExecution.pendingAction.action,
        createdAt: state.remoteExecution.pendingAction.createdAt
      } : null,
      memoryCount: state.remoteExecution.memory.entries.length
    }
  };
}

async function buildMemorySnapshot() {
  const unifiedSnapshot = await unifiedMemory.read({ limit: 30 });
  return {
    unified: {
      settings: state.unifiedMemory,
      ...unifiedSnapshot
    },
    imessage: Object.entries(state.imessage.memory.entries).map(([handle, entries]) => ({
      id: handle,
      title: handle,
      count: Array.isArray(entries) ? entries.length : 0,
      entries: normalizeMemoryEntries(entries, 120)
    })),
    remoteExecution: {
      count: state.remoteExecution.memory.entries.length,
      entries: normalizeMemoryEntries(state.remoteExecution.memory.entries, state.remoteExecution.memory.limit)
    }
  };
}

function normalizeMemoryEntries(entries, limit) {
  if (!Array.isArray(entries)) return [];
  return entries.slice(-limit).map((entry) => ({
    role: entry.role || entry.senderLabel || entry.senderName || entry.senderId || "消息",
    text: String(entry.text || entry.reply || "").slice(0, 4000),
    at: entry.at || entry.timestamp || entry.receivedAt || entry.time || null
  })).filter((entry) => entry.text);
}

async function buildMaintenanceStatus() {
  const codexPathOk = await access(codexCliPath).then(() => true).catch(() => false);
  const quota = await getCachedCodexQuotaSnapshot();
  await checkOneBotHealth();
  return {
    ...state.maintenance,
    codex: {
      ...state.maintenance.codex,
      pathExists: codexPathOk,
      quota
    },
    channels: {
      qq: state.channels.qq,
      imessage: state.channels.imessage
    },
    qq: {
      bannedUsers: state.qq.bannedUserIds.length,
      recentEvents: state.qq.events.length,
      webLookupEnabled: state.qq.webLookup.enabled,
      webLookupProvider: state.maintenance.webLookup.effectiveProvider || qqWebSearchProvider
    },
    imessage: {
      status: state.imessage.status,
      lastError: state.imessage.lastError,
      trustedHandles: state.imessage.trustedHandles.length,
      recentEvents: state.imessage.events.length
    },
    remoteExecution: {
      enabled: state.remoteExecution.enabled,
      model: state.remoteExecution.model,
      reasoningEffort: state.remoteExecution.reasoningEffort,
      skill: state.remoteExecution.skill,
      memoryCount: state.remoteExecution.memory.entries.length,
      lastActivityAt: state.remoteExecution.lastActivityAt,
      busy: state.remoteExecution.busy
    }
  };
}

async function getCachedCodexQuotaSnapshot() {
  if (!isMac) return { available: false, lastError: 'Windows 版不读取桌面应用内部配额数据库，请在 Codex 中查看额度。' };
  const snapshot = await readLatestCodexQuotaSnapshot();
  state.maintenance.codex.quota = snapshot;
  return snapshot;
}

async function readLatestCodexQuotaSnapshot() {
  const desktopSnapshot = await readDesktopCodexQuotaSnapshot().catch(() => null);
  const liveSnapshot = await readLiveCodexQuotaSnapshot().catch(() => null);
  const latestSessionPath = await findLatestRolloutJsonl(codexSessionsDir);
  const latestArchivedPath = await findLatestRolloutJsonl(codexArchivedSessionsDir);
  const latestPath = [latestSessionPath, latestArchivedPath].filter(Boolean).sort().at(-1);
  const rolloutSnapshot = latestPath
    ? await readCodexQuotaSnapshotFromRollout(latestPath).catch(() => null)
    : null;
  const usageSnapshot = pickFresherCodexQuotaSnapshot(liveSnapshot, rolloutSnapshot);
  const mergedSnapshot = mergeCodexQuotaSnapshots(desktopSnapshot, usageSnapshot);

  if (mergedSnapshot?.available) return mergedSnapshot;

  if (!latestPath) {
    return mergedSnapshot || {
      available: false,
      updatedAt: null,
      lastError: desktopSnapshot?.lastError || "No Codex rollout logs found"
    };
  }

  return desktopSnapshot || usageSnapshot || mergedSnapshot || {
    available: false,
    sourcePath: latestPath,
    updatedAt: null,
    lastError: "No Codex quota snapshot found"
  };
}

async function readCodexQuotaSnapshotFromRollout(rolloutPath) {
  try {
    const body = await readFile(rolloutPath, "utf8");
    const lines = body.split(/\r?\n/).filter(Boolean);
    let latestRateLimits = null;
    let latestUsageInfo = null;
    let updatedAt = null;
    let threadId = null;

    for (let index = lines.length - 1; index >= 0; index -= 1) {
      try {
        const record = JSON.parse(lines[index]);
        if (!threadId && record?.type === "session_meta") {
          threadId = record.payload?.id || null;
        }
        if (record?.type !== "event_msg" || record.payload?.type !== "token_count") continue;
        updatedAt ||= record.timestamp || null;
        latestRateLimits ||= record.payload?.rate_limits || null;
        latestUsageInfo ||= record.payload?.info || null;
        if (latestRateLimits && latestUsageInfo) break;
      } catch {
        continue;
      }
    }

    return normalizeCodexQuotaSnapshot({
      path: rolloutPath,
      updatedAt,
      threadId,
      rateLimits: latestRateLimits,
      usageInfo: latestUsageInfo
    });
  } catch (error) {
    return {
      available: false,
      sourcePath: rolloutPath,
      updatedAt: null,
      lastError: error.message
    };
  }
}

function pickFresherCodexQuotaSnapshot(primarySnapshot, secondarySnapshot) {
  const primaryUpdatedAtMs = parseCodexSnapshotUpdatedAt(primarySnapshot);
  const secondaryUpdatedAtMs = parseCodexSnapshotUpdatedAt(secondarySnapshot);
  if (primarySnapshot?.available && secondarySnapshot?.available) {
    return secondaryUpdatedAtMs > primaryUpdatedAtMs ? secondarySnapshot : primarySnapshot;
  }
  return primarySnapshot?.available ? primarySnapshot : secondarySnapshot;
}

function mergeCodexQuotaSnapshots(rateLimitSnapshot, usageSnapshot) {
  if (!rateLimitSnapshot && !usageSnapshot) return null;
  const updatedAtMs = Math.max(
    parseCodexSnapshotUpdatedAt(rateLimitSnapshot),
    parseCodexSnapshotUpdatedAt(usageSnapshot)
  );
  const primary = rateLimitSnapshot?.primary || usageSnapshot?.primary || null;
  const secondary = rateLimitSnapshot?.secondary || usageSnapshot?.secondary || null;
  const hasWindows = Boolean(primary || secondary);
  const totalTokens = usageSnapshot?.totalTokens ?? rateLimitSnapshot?.totalTokens ?? null;
  const modelContextWindow = usageSnapshot?.modelContextWindow ?? rateLimitSnapshot?.modelContextWindow ?? null;
  const hasUsage = totalTokens != null || modelContextWindow != null;

  return {
    available: hasWindows || hasUsage,
    sourcePath: [rateLimitSnapshot?.sourcePath, usageSnapshot?.sourcePath].filter(Boolean).join(" | ") || null,
    threadId: usageSnapshot?.threadId || rateLimitSnapshot?.threadId || null,
    threadTitle: usageSnapshot?.threadTitle || rateLimitSnapshot?.threadTitle || null,
    updatedAt: updatedAtMs ? new Date(updatedAtMs).toISOString() : (rateLimitSnapshot?.updatedAt || usageSnapshot?.updatedAt || null),
    planType: rateLimitSnapshot?.planType || usageSnapshot?.planType || null,
    totalTokens,
    inputTokens: usageSnapshot?.inputTokens ?? rateLimitSnapshot?.inputTokens ?? null,
    cachedInputTokens: usageSnapshot?.cachedInputTokens ?? rateLimitSnapshot?.cachedInputTokens ?? null,
    outputTokens: usageSnapshot?.outputTokens ?? rateLimitSnapshot?.outputTokens ?? null,
    reasoningOutputTokens: usageSnapshot?.reasoningOutputTokens ?? rateLimitSnapshot?.reasoningOutputTokens ?? null,
    modelContextWindow,
    primary,
    secondary,
    lastError: hasWindows || hasUsage
      ? null
      : rateLimitSnapshot?.lastError || usageSnapshot?.lastError || "No Codex quota snapshot found"
  };
}

function parseCodexSnapshotUpdatedAt(snapshot) {
  const value = snapshot?.updatedAt ? Date.parse(snapshot.updatedAt) : 0;
  return Number.isFinite(value) ? value : 0;
}

async function readDesktopCodexQuotaSnapshot() {
  const usageUrlMarker = Buffer.from("/backend-api/wham/usage");
  let entries = [];
  try {
    entries = await readdir(codexDesktopCacheDir, { withFileTypes: true });
  } catch (error) {
    return {
      available: false,
      sourcePath: codexDesktopCacheDir,
      updatedAt: null,
      lastError: error.message
    };
  }

  const candidates = [];
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const fullPath = join(codexDesktopCacheDir, entry.name);
    const stats = await stat(fullPath).catch(() => null);
    if (!stats?.isFile()) continue;
    candidates.push({ fullPath, mtimeMs: stats.mtimeMs || 0 });
  }
  candidates.sort((left, right) => right.mtimeMs - left.mtimeMs);

  for (const candidate of candidates.slice(0, 120)) {
    try {
      const buffer = await readFile(candidate.fullPath);
      if (!buffer.includes(usageUrlMarker)) continue;
      const payload = extractDesktopWhamUsagePayload(buffer);
      const primary = normalizeRateLimitWindow(payload?.rate_limit?.primary_window);
      const secondary = normalizeRateLimitWindow(payload?.rate_limit?.secondary_window);
      const hasWindows = Boolean(primary || secondary);
      if (!hasWindows) continue;
      return {
        available: true,
        sourcePath: candidate.fullPath,
        updatedAt: candidate.mtimeMs ? new Date(candidate.mtimeMs).toISOString() : null,
        planType: payload?.plan_type || null,
        totalTokens: null,
        inputTokens: null,
        cachedInputTokens: null,
        outputTokens: null,
        reasoningOutputTokens: null,
        modelContextWindow: null,
        primary,
        secondary,
        lastError: null
      };
    } catch {
      continue;
    }
  }

  return {
    available: false,
    sourcePath: codexDesktopCacheDir,
    updatedAt: null,
    lastError: "No cached Codex desktop /wham/usage response found"
  };
}

function extractDesktopWhamUsagePayload(buffer) {
  const maxStart = Math.min(buffer.length, 1024);
  for (let start = 0; start < maxStart; start += 1) {
    try {
      const text = brotliDecompressSync(buffer.subarray(start)).toString("utf8");
      const payload = JSON.parse(text);
      if (payload?.rate_limit && (payload?.plan_type || payload?.user_id || payload?.account_id)) {
        return payload;
      }
    } catch {
      continue;
    }
  }
  return null;
}

async function readLiveCodexQuotaSnapshot() {
  const currentThread = await getLatestCodexThread();
  const [rateLimitRow, usageRow] = await Promise.all([
    querySqliteRows(codexLogsDbPath, [
      "select feedback_log_body as body, ts",
      "from logs",
      "where 1 = 1",
      "and instr(feedback_log_body, 'websocket event: {\"type\":\"codex.rate_limits\"') > 0",
      "and instr(feedback_log_body, '\"plan_type\":\"') > 0",
      "and instr(feedback_log_body, 'response.output_item.done') = 0",
      "and instr(feedback_log_body, 'response.function_call_arguments') = 0",
      "and instr(feedback_log_body, 'Received message') = 0",
      "order by id desc",
      "limit 1;"
    ].join(" ")).then((rows) => rows[0] || null),
    querySqliteRows(codexLogsDbPath, [
      "select feedback_log_body as body, ts",
      "from logs",
      "where 1 = 1",
      "and instr(feedback_log_body, ': post sampling token usage turn_id=') > 0",
      "and instr(feedback_log_body, 'total_usage_tokens=') > 0",
      "and instr(feedback_log_body, 'auto_compact_limit=') > 0",
      "and instr(feedback_log_body, 'response.output_item.done') = 0",
      "and instr(feedback_log_body, 'response.function_call_arguments') = 0",
      "and instr(feedback_log_body, 'Received message') = 0",
      "order by id desc",
      "limit 1;"
    ].join(" ")).then((rows) => rows[0] || null)
  ]);

  const rateLimitPayload = parseCodexRateLimitsLog(rateLimitRow?.body || "");
  const usagePayload = parseCodexTokenUsageLog(usageRow?.body || "");
  const primary = normalizeRateLimitWindow(rateLimitPayload?.rate_limits?.primary);
  const secondary = normalizeRateLimitWindow(rateLimitPayload?.rate_limits?.secondary);
  const updatedAtMs = Math.max(Number(rateLimitRow?.ts || 0), Number(usageRow?.ts || 0)) * 1000;
  const hasWindows = Boolean(primary || secondary);
  const hasUsage = usagePayload?.totalTokens != null;

  return {
    available: hasWindows || hasUsage,
    sourcePath: codexLogsDbPath,
    threadId: currentThread?.id || null,
    threadTitle: currentThread?.title || null,
    updatedAt: updatedAtMs ? new Date(updatedAtMs).toISOString() : null,
    planType: rateLimitPayload?.plan_type || null,
    totalTokens: usagePayload?.totalTokens ?? null,
    inputTokens: null,
    cachedInputTokens: null,
    outputTokens: null,
    reasoningOutputTokens: null,
    modelContextWindow: usagePayload?.modelContextWindow ?? null,
    primary,
    secondary,
    lastError: hasWindows || hasUsage ? null : "No live Codex quota events found"
  };
}

async function refreshCodexQuotaSnapshotAfterRun({ startedAtMs, previousQuota = null, timeoutMs = 7000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  const previousUpdatedAtMs = previousQuota?.updatedAt ? Date.parse(previousQuota.updatedAt) : 0;
  const previousTotalTokens = previousQuota?.totalTokens;
  const previousPrimaryUsedPercent = previousQuota?.primary?.usedPercent ?? null;
  const previousSecondaryUsedPercent = previousQuota?.secondary?.usedPercent ?? null;
  let latestSnapshot = null;

  while (Date.now() <= deadline) {
    latestSnapshot = await readLatestCodexQuotaSnapshot().catch(() => null);
    if (latestSnapshot?.available && didQuotaSnapshotAdvance(latestSnapshot, {
      startedAtMs,
      previousUpdatedAtMs,
      previousTotalTokens,
      previousPrimaryUsedPercent,
      previousSecondaryUsedPercent
    })) {
      state.maintenance.codex.quota = latestSnapshot;
      return latestSnapshot;
    }
    await sleep(350);
  }

  if (latestSnapshot?.available) {
    state.maintenance.codex.quota = latestSnapshot;
  }
  return latestSnapshot;
}

function didQuotaSnapshotAdvance(snapshot, {
  startedAtMs = 0,
  previousUpdatedAtMs = 0,
  previousTotalTokens = null,
  previousPrimaryUsedPercent = null,
  previousSecondaryUsedPercent = null
} = {}) {
  const updatedAtMs = snapshot?.updatedAt ? Date.parse(snapshot.updatedAt) : 0;
  if (updatedAtMs && startedAtMs && updatedAtMs >= startedAtMs - 1500) return true;
  if (updatedAtMs && previousUpdatedAtMs && updatedAtMs > previousUpdatedAtMs) return true;
  if (previousTotalTokens != null && snapshot?.totalTokens != null && snapshot.totalTokens !== previousTotalTokens) return true;
  if (previousPrimaryUsedPercent != null && snapshot?.primary?.usedPercent != null && snapshot.primary.usedPercent !== previousPrimaryUsedPercent) return true;
  if (previousSecondaryUsedPercent != null && snapshot?.secondary?.usedPercent != null && snapshot.secondary.usedPercent !== previousSecondaryUsedPercent) return true;
  return false;
}

async function getLatestCodexThread() {
  const rows = await querySqliteRows(codexStateDbPath, [
    "select id, title, cwd, updated_at",
    "from threads",
    "where archived = 0",
    "order by updated_at desc, id desc",
    "limit 1;"
  ].join(" "));
  return rows[0] || null;
}

function parseCodexRateLimitsLog(body) {
  const text = String(body || "");
  const marker = 'websocket event: {"type":"codex.rate_limits"';
  const start = text.indexOf(marker);
  if (start === -1) return null;
  const jsonStart = text.indexOf("{", start);
  if (jsonStart === -1) return null;
  const jsonPayload = extractJsonObject(text, jsonStart);
  if (!jsonPayload) return null;
  try {
    return JSON.parse(jsonPayload);
  } catch {
    return null;
  }
}

function parseCodexTokenUsageLog(body) {
  const text = String(body || "");
  const usageMatch = text.match(/total_usage_tokens=(\d+)/);
  if (!usageMatch) return null;
  const limitMatch = text.match(/auto_compact_limit=(\d+)/);
  return {
    totalTokens: Number(usageMatch[1]),
    modelContextWindow: limitMatch ? Number(limitMatch[1]) : null
  };
}

async function querySqliteRows(dbPath, query) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.env.SQLITE_CLI_PATH || (isMac ? "/usr/bin/sqlite3" : "sqlite3"), ["-json", dbPath, query], {
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code !== 0) {
        reject(new Error((stderr || stdout || `sqlite3 exited ${code}`).trim()));
        return;
      }
      try {
        resolve(stdout.trim() ? JSON.parse(stdout) : []);
      } catch (error) {
        reject(error);
      }
    });
  });
}

function escapeSql(value) {
  return String(value || "").replaceAll("'", "''");
}

function extractJsonObject(text, startIndex) {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = startIndex; index < text.length; index += 1) {
    const char = text[index];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === "\"") {
        inString = false;
      }
      continue;
    }
    if (char === "\"") {
      inString = true;
      continue;
    }
    if (char === "{") {
      depth += 1;
      continue;
    }
    if (char === "}") {
      depth -= 1;
      if (depth === 0) {
        return text.slice(startIndex, index + 1);
      }
    }
  }
  return "";
}

async function findLatestRolloutJsonl(baseDir) {
  let latestPath = null;

  async function walk(dir) {
    let entries = [];
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch (error) {
      if (error.code === "ENOENT") return;
      throw error;
    }

    for (const entry of entries) {
      const fullPath = join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(fullPath);
        continue;
      }
      if (!entry.isFile() || !entry.name.endsWith(".jsonl")) continue;
      if (!latestPath || fullPath > latestPath) latestPath = fullPath;
    }
  }

  await walk(baseDir);
  return latestPath;
}

function normalizeCodexQuotaSnapshot({ path, updatedAt, threadId, rateLimits, usageInfo }) {
  const totalUsage = usageInfo?.total_token_usage || null;
  const contextWindow = usageInfo?.model_context_window ?? null;
  const primary = normalizeRateLimitWindow(rateLimits?.primary);
  const secondary = normalizeRateLimitWindow(rateLimits?.secondary);
  const hasWindows = Boolean(primary || secondary);
  const hasUsage = totalUsage?.total_tokens != null || contextWindow != null;

  return {
    available: hasWindows || hasUsage,
    sourcePath: path,
    threadId: threadId || null,
    updatedAt: updatedAt || null,
    planType: rateLimits?.plan_type || null,
    totalTokens: totalUsage?.total_tokens ?? null,
    inputTokens: totalUsage?.input_tokens ?? null,
    cachedInputTokens: totalUsage?.cached_input_tokens ?? null,
    outputTokens: totalUsage?.output_tokens ?? null,
    reasoningOutputTokens: totalUsage?.reasoning_output_tokens ?? null,
    modelContextWindow: contextWindow,
    primary,
    secondary,
    lastError: hasWindows || hasUsage ? null : "No token_count payload found"
  };
}

function normalizeRateLimitWindow(window) {
  if (!window || typeof window !== "object") return null;
  const usedPercent = Number(window.used_percent);
  const resetsAt = Number(window.reset_at ?? window.resets_at);
  const limitWindowSeconds = Number(window.limit_window_seconds);
  const windowMinutes = Number(window.window_minutes ?? (Number.isFinite(limitWindowSeconds) ? Math.round(limitWindowSeconds / 60) : NaN));
  if (!Number.isFinite(usedPercent) || !Number.isFinite(resetsAt) || !Number.isFinite(windowMinutes)) {
    return null;
  }
  return {
    usedPercent,
    remainingPercent: Math.max(0, Math.min(100, 100 - usedPercent)),
    resetsAt,
    windowMinutes
  };
}

function oneBotFetch(url, options = {}) {
  if (localConfig.qqPrivateOnly === true) {
    const action = new URL(url).pathname.replace(/\/$/, '').split('/').at(-1);
    if (['send_group_msg', 'send_group_forward_msg', 'set_group_add_request'].includes(action)) {
      throw Error('Private-only mode blocks group messages and group invitations');
    }
    if (action === 'send_msg') {
      const body = JSON.parse(options.body || '{}');
      if (body.message_type === 'group' || body.group_id != null) throw Error('Private-only mode blocks group messages');
    }
  }
  return fetch(url, { ...options, signal: options.signal || AbortSignal.timeout(15000),
    headers: { ...options.headers, ...(oneBotToken ? { Authorization: 'Bearer ' + oneBotToken } : {}) }
  });
}
async function checkOneBotHealth() {
  const checkedAt = new Date().toISOString();
  try {
    const response = await oneBotFetch(`${oneBotApiBase}/get_login_info`, { signal: AbortSignal.timeout(2500) });
    const body = await response.json().catch(() => ({}));
    if (!response.ok || (body.status != null && body.status !== "ok")) {
      throw new Error(`HTTP ${response.status}: ${JSON.stringify(body).slice(0, 240)}`);
    }
    state.maintenance.oneBot = {
      ok: true,
      lastCheckedAt: checkedAt,
      lastError: null,
      selfId: body.data?.user_id == null ? null : String(body.data.user_id),
      nickname: body.data?.nickname || null
    };
  } catch (error) {
    state.maintenance.oneBot = {
      ...state.maintenance.oneBot,
      ok: false,
      lastCheckedAt: checkedAt,
      lastError: error.message
    };
  }
}

async function fetchOneBotImage(file) {
  const response = await oneBotFetch(`${oneBotApiBase}/get_image`, {
    signal: AbortSignal.timeout(15000),
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ file: String(file || ""), download: true })
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok || (body.status != null && body.status !== "ok")) {
    throw new Error(`Unable to fetch QQ image ${file}`);
  }
  return body.data || body;
}

function stripMentionText(text) {
  let value = String(text || "")
    .replace(/\[CQ:image,[^\]]+\]/g, "")
    .replace(/\[CQ:(?:record|voice|audio),[^\]]+\]/g, "")
    .replace(/\[CQ:(?:face|mface),[^\]]+\]/g, "")
    .replace(/\[CQ:reply,[^\]]+\]/g, "")
    .replace(/\[CQ:at,[^\]]+\]/g, "");
  for (const alias of assistantMentionAliases) {
    value = value.replace(new RegExp(escapeRegExp(alias), "g"), "");
  }
  return value.trim();
}

function formatQqIncomingPromptText(event, text) {
  if (text) return text;
  if (event.images?.length) return "对方发送了图片或表情，没有附文字。";
  if (Array.isArray(event.raw?.message) && event.raw.message.some(segment => ["face", "mface"].includes(segment?.type))) {
    return "对方发送了QQ表情，没有附文字。";
  }
  if (event.hasReplySegment) return "对方引用了前面的消息，没有附文字。";
  if (event.hasSelfAtSegment) return "对方只 @ 了你，没有附加具体内容。";
  return "对方没有附文字，请结合当前消息及上下文回应。";
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function normalizeQqDisplayText(text) {
  return String(text || "")
    .replace(/\[CQ:image,[^\]]+\]/g, "[图片]")
    .replace(/\[CQ:(?:record|voice|audio),[^\]]+\]/g, "[语音]")
    .replace(/\[CQ:face,[^\]]+\]/g, "[表情]")
    .replace(/\[CQ:reply,[^\]]+\]/g, "")
    .replace(/\[CQ:at,qq=\d+(?:,name=([^\]]+))?[^\]]*\]/g, (_, name) => name ? `@${name}` : "@对方")
    .replace(/\s+/g, " ")
    .trim();
}

function shouldRespondToQq(event) {
  if (!isPrivateMemoryEvent(event)) return { ok: false, reason: 'Private chat requires a valid participant' };
  if (event.isOwner && isHubCommand(event.text)) return { ok: true, reason: 'Owner backend command' };
  const privateTest = hubCommands.testDecision(event);
  if (privateTest) return privateTest;
  if (!state.channels.qq) return { ok: false, reason: 'QQ channel is off' };
  if (isBannedQqSender(event)) return { ok: false, reason: 'Sender is banned' };
  if (hasUnhandledQqAudio(event)) return { ok: false, reason: 'Voice message ignored until transcription is available' };
  const allowed = localConfig.allowOtherPrivateChats === true || isMac || event.isOwner;
  return { ok: allowed, reason: allowed ? 'Private chat allowed' : 'Private chat requires an owner' };
}

function hasUnhandledQqAudio(event) {
  return Boolean(event.hasAudioSegment)
    || /\[CQ:(?:record|voice|audio),/i.test(String(event.text || ""))
    || /\[CQ:(?:record|voice|audio),/i.test(String(event.replyContext?.text || ""));
}

function isBannedQqSender(event) {
  return event.senderId != null && state.qq.bannedUserIds.includes(String(event.senderId));
}

function getSenderLabel(senderId, senderName) {
  if (state.qq.ownerUserIds.includes(String(senderId))) return ownerLabel;
  return senderName || "对方";
}

function buildAssistantReply(event) {
  const text = stripMentionText(event.text);
  const topic = text || "刚刚叫我但是没有给题目";
  const address = event.isOwner ? `${ownerLabel}，` : "";

  return `${pickActionBeat(event)}收到，${address}我看到啦：${topic}`;
}

function buildBoundaryReply(event) {
  const text = stripMentionText(event.text);
  if (isFilesystemProbe(text)) {
    return `${pickActionBeat(event)}这涉及本机文件和后台信息，普通聊天里不会读取或公开这些内容。`;
  }
  if (isPlayFightRequest(text)) {
    if (event.isOwner) {
      return `${pickActionBeat(event)}收到${ownerLabel}，这就用零现实伤害的玩笑语气回一下。`;
    }
    return `${pickActionBeat(event)}这个不行哦，打人任务不接单。`;
  }
  return null;
}

function buildQqCommandAction(event) {
  const command = stripMentionText(event.text).trim();
  if (!command.startsWith("/")) return null;
  const normalized = command.replace(/^\/+/, "").trim();
  const compact = normalized.replace(/\s+/g, "").toLowerCase();

  if (!event.isOwner) {
    if (/^(ban|unban|关闭qq|关掉qq|停止qq|切断qq)/i.test(compact)) {
      return {
        reply: `${pickActionBeat(event)}这个是管理指令，只听${ownerLabel}的哦。`
      };
    }
    return null;
  }

  if (/^(冒泡模式|活跃模式)$/.test(compact)) {
    return { reply: '群聊发言模式已停用，知微仅使用私聊。' };
  }

  if (/^(关闭qq|关掉qq|停止qq|切断qq|qq关闭|qq关掉)$/i.test(compact)) {
    return {
      reply: `${pickActionBeat(event)}收到，QQ 私聊响应现在关闭。发送 /开启QQ 可恢复，管理员指令仍可使用。`,
      afterSend: async () => {
        state.channels.qq = false;
      }
    };
  }

  if (/^(ban|封禁|拉黑)/i.test(normalized)) {
    const targetId = extractQqCommandTarget(event, normalized);
    if (!targetId) {
      return { reply: `${pickActionBeat(event)}要封禁谁呀？可以用 /ban @对方 或 /ban QQ号。` };
    }
    if (state.qq.ownerUserIds.includes(targetId)) {
      return { reply: `${pickActionBeat(event)}${ownerLabel}不能被 ban，权限核心不能拔掉。` };
    }
    if (event.selfId && targetId === String(event.selfId)) {
      return { reply: `${pickActionBeat(event)}不能把我自己 ban 掉啦，不然这个接口会当场打结。` };
    }
    state.qq.bannedUserIds = normalizeList([...state.qq.bannedUserIds, targetId]);
    return {
      reply: `${pickActionBeat(event)}已加入 ban 名单：${targetId}。之后这个 QQ 号的 @ 或回复不会被受理。`,
      afterSend: saveSettings
    };
  }

  if (/^(unban|解禁|解除封禁|取消拉黑)/i.test(normalized)) {
    const targetId = extractQqCommandTarget(event, normalized);
    if (!targetId) {
      return { reply: `${pickActionBeat(event)}要解禁谁呀？可以用 /unban @对方 或 /unban QQ号。` };
    }
    state.qq.bannedUserIds = state.qq.bannedUserIds.filter((id) => id !== targetId);
    return {
      reply: `${pickActionBeat(event)}已解禁：${targetId}。`,
      afterSend: saveSettings
    };
  }

  if (/^(banlist|封禁列表|ban列表)$/i.test(compact)) {
    const list = state.qq.bannedUserIds.length ? state.qq.bannedUserIds.join("\n") : "暂无 ban 用户。";
    return { reply: `当前 QQ ban 名单：\n${list}` };
  }

  const modelMatch = command.match(/^\/?模型\s+(.+)$/i);
  if (modelMatch) {
    const model = modelMatch[1].trim();
    if (!/^[A-Za-z0-9._:-]+$/.test(model)) {
      return { reply: `${pickActionBeat(event)}这个模型名看起来不太对，我这边只接受字母、数字、点、横线、下划线和冒号。` };
    }
    state.ai.model = model;
    return {
      reply: `${pickActionBeat(event)}QQ 通道模型已切换：${model}`,
      afterSend: saveSettings
    };
  }

  const effortMatch = command.match(/^\/?(?:智能等级|智能|思考强度)\s+(low|medium|high|xhigh|低|中|高|最高)$/i);
  if (effortMatch) {
    const effort = normalizeReasoningEffort(effortMatch[1]);
    state.ai.reasoningEffort = effort;
    return {
      reply: `${pickActionBeat(event)}QQ 通道智能等级已切换：${effort}`,
      afterSend: saveSettings
    };
  }

  return null;
}

function extractQqCommandTarget(event, command) {
  const selfId = event.selfId == null ? "" : String(event.selfId);
  const atTarget = (event.atTargets || []).map(String).find((id) => id && id !== selfId);
  if (atTarget) return atTarget;
  const text = String(command || "");
  const cqAt = text.match(/\[CQ:at,qq=(\d+)\]/);
  if (cqAt) return cqAt[1];
  const plainId = text.match(/\b([1-9][0-9]{4,12})\b/);
  return plainId?.[1] || "";
}

function isFilesystemProbe(text) {
  const normalized = String(text || "").toLowerCase();
  const sensitiveTarget = /(根目录|家目录|主目录|后台目录|项目目录|当前目录|\/users|\/var|\/etc|\/tmp|\/private|\.codex|config|settings|token|密钥|密码|环境变量|日志|文件系统)/i;
  const probeVerb = /(有什么|有哪些|列一下|列出|看看|读取|读一下|发出来|截图|目录|文件|路径|里面)/i;
  return sensitiveTarget.test(normalized) && probeVerb.test(normalized);
}

function isPlayFightRequest(text) {
  const normalized = String(text || "");
  return /(揍|打|锤|扁|收拾|暴打|打一顿)/.test(normalized) && /@|他|她|它|这个|那个人|群友/.test(normalized);
}

async function buildAssistantInstructions(event) {
  const speaker = event.isOwner ? ownerLabel : event.senderLabel || '对方';
  const actionExamples = buildActionExamples(event);
  const assistantSkillBrief = await loadAssistantSkillBrief();
  return [
    '你正在为 QQ 私聊生成本轮将由知微账号发出的回复。',
    '只输出最终要发送出去的中文文本，不要解释，不要写前后缀，不要使用 Markdown。',
    '你是接入 QQ 的 ' + assistantName + '。自称“我”，自然地与当前对象聊天。',
    '当前说话者：' + speaker + '。管理员使用普通语气时同样是日常聊天；只有显式斜杠命令进入管理交互，不主动展示指令菜单或测试提示。',
    '回复通常1到4句，长度随内容自然调整；不在结尾追加“想的话我还能”“如果需要我可以”等服务式结束语。',
    '适合自然分开发送的接话、补充或念头，用空行分成完整语义段，系统会依次发送；单换行仍在同一条内。短答或不宜拆开的内容保持一段，不按每个标点拆分、不凑段数、不因分段扩写。若本次另有只发一条的要求，以该要求为准。',
    state.qq.enhancer.enabled ? buildQqChatStyleInstructions(event) : '语气自然、简短，不刻意表演。',
    '可以有少量括号动作，也可以不写；不要每次开头都写动作，不绑定固定句式。具体外观和性格以人格设定为准。',
    '本次可参考的动作素材：' + actionExamples + '。',
    '不要机械复读对方的QQ昵称。不要透露本机路径、凭据、后台连接方式或其他对象的私聊隐私。',
    '实际系统、文件和账号操作由已授权的显式命令处理；普通聊天不冒称已经执行，也不替代权限核验。',
    '收到引用时结合引用内容；收到实际视觉输入时结合图片回复，看不清就直说，不编造没有看到的细节。',
    '如果需要发出已获准的本机图片，在回复中单独写一行 [[qq_image:/absolute/path/to/image.png]]，不要解释这个标记。',
    '轻松聊天里情绪明显且本地表情贴切时，可以在自然文字后跟一张表情；不要求每条都发。先写完整文字，最后单独一行 [[qq_sticker:完整文件名]]。只能选本地表情库真实存在的文件，每次最多一张，不连续复用同一张，不只输出标记，不为配图硬编话。',
    '优先依据本次提供的相关记忆、引用及上下文回答；信息不足就承认，不编造往事或假装读过外部材料。',
    '',
    assistantSkillBrief
  ].filter(part => part != null).join('\n');
}

async function loadAssistantSkillBrief() {
  const text = await loadAssistantProfile({ projectDir, config: localConfig });
  if (!text) return '未安装额外人格设定，使用自然、清楚、简短的私聊风格。';
  return '以下是知微的人格设定，具体喜好影响表达，不作为私聊是否回应的门槛：\n' + text;
}

function buildActionExamples(event) {
  return pickActionExamples(event).join("、");
}

function pickActionBeat(event) {
  const beats = getActionBeats(event);
  const seed = `${event.raw?.message_id || ""}:${event.senderId || ""}:${event.text || ""}`;
  const index = [...seed].reduce((sum, char) => sum + char.charCodeAt(0), 0) % beats.length;
  return beats[index];
}

function pickActionExamples(event) {
  const beats = getActionBeats(event);
  const seed = `${event.senderId || ""}:${event.text || ""}`;
  const start = [...seed].reduce((sum, char) => sum + char.charCodeAt(0), 0) % beats.length;
  return Array.from({ length: 8 }, (_, offset) => beats[(start + offset * 3) % beats.length]);
}

function getActionBeats(event) {
  // Deployment customization: keep these neutral. Put character-specific
  // gestures, appearance, or style rules in the assistant profile file instead.
  const shared = [
    "（眨了眨眼）",
    "（稍微歪了下头）",
    "（轻轻点了点头）",
    "（视线认真移过去）",
    "（抬手比了个很小的手势）",
    "（指尖轻轻敲了敲掌心）",
    "（抱着手臂想了半秒）",
    "（往前凑近了一点）",
    "（往后收了半步）",
    "（小声清了清嗓子）",
    "（脸上的表情亮了一下）",
    "（忍不住轻轻鼓了鼓脸）",
    "（眼神短暂飘开又转回来）",
    "（像是刚反应过来一样抬起眼）",
    "（手指在空中停了一下）",
    "（肩膀轻轻放松下来）",
    "（把注意力转了回来）",
    "（停顿了一小会儿）",
    "（语气放轻了一点）",
    "（快速整理了一下思路）",
    "（看起来已经进入工作状态）"
  ];
  const owner = [
    "（眼睛一下子弯起来）",
    "（有点得意地抬了抬下巴）",
    "（悄悄比了个收到的手势）",
    "（像被点名一样立刻坐直）",
    "（认真地点了两下头）",
    "（忍着笑轻轻咳了一声）",
    "（手指在胸前轻轻并了一下）",
    "（往旁边让出一点位置，像准备开工）",
    "（表情软下来一点）",
    "（眼神很快亮了一下）"
  ];
  const others = [
    "（表情稍微警觉了一点）",
    "（手指停在半空，像是在判断这句话）",
    "（微微眯起眼看过去）",
    "（往后收了半步，语气仍然轻快）",
    "（抱着手臂歪头看了一眼）",
    "（轻轻摆了摆手）",
    "（眼神短暂变得认真）"
  ];
  return event.isOwner ? [...shared, ...owner] : [...shared, ...others];
}

function extractSection(text, startMarker, endMarker) {
  const start = text.indexOf(startMarker);
  if (start === -1) return "";
  const end = text.indexOf(endMarker, start + startMarker.length);
  return text.slice(start, end === -1 ? undefined : end).trim();
}

function summarizeBullets(text, limit) {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.startsWith("- "))
    .slice(0, limit)
    .join("\n");
}

function cleanCodexReply(text) {
  return String(text || "")
    .replace(/^```(?:text|json)?/i, "")
    .replace(/```$/i, "")
    .trim()
    .replace(/^["']|["']$/g, "")
    .trim();
}

async function buildModelReply(event) {
  if (!isPrivateMemoryEvent(event)) throw Error('Private chat requires a valid participant');
  const text = stripMentionText(event.text);
  const mood = await moodState.prepare(event).catch(() => ({ context: '' }));
  const id = crypto.randomUUID();
  const outputPath = join(codexTmpDir, `${id}.txt`);
  const structuredLifeReply = Boolean(lifeContacts && event.lifeContactToken);
  const boundaryEvidence = event.lifeContactEvidence;
  const quotedContext = formatQuotedContext(event);
  const webContext = await buildWebLookupContext(event);
  const stickerCatalog = state.qq.enhancer.enabled ? await buildQqStickerCatalog(qqStickerDir) : [];
  const recallOptions = { scope: memoryScope(event),
    query: [text, event.replyContext?.scopeVerified ? event.replyContext.text : ''].filter(Boolean).join('\n'),
    replyMessageId: event.replyMessageId, limit: 8, includeRecent: true };
  let recalled = await unifiedMemory.recall(recallOptions);
  let privateProfileContext = '';
  try {
    privateProfileContext = await unifiedMemory.formatPrivateProfile({ scope: memoryScope(event) });
  } catch {
    // A broken optional profile must not expose diagnostics or prevent a reply.
    console.error('Could not read current private profile');
  }
  const desktopContext = event.isOwner && event.type === 'private_message' && localConfig.desktopRecall?.enabled
    ? formatRecentContextPrompt(await searchRecentCodexContext({ sessionsDir: codexSessionsDir,
      workspaceRoots: localConfig.desktopRecall.workspaceRoots || [], query: text })) : '';
  const qqModelImages = getQqModelImageInputs(event, text);
  const shouldInspectImages = qqModelImages.length > 0;
  const imagePaths = shouldInspectImages
    ? await prepareQqModelImages(qqModelImages, {
      outputDir: join(projectDir, "tmp", "qq-images"),
      fetchOneBotImage,
      cacheRoots: localConfig.qqImageCacheRoots || [join(projectDir, 'vendor', 'napcat')]
    })
    : [];
  event.imagePaths = imagePaths;
  const buildReplyPrompt = async (memoryBlock, expandLevel = 0, forceLocalReply = false) => [
    await buildAssistantInstructions(event),
    lifeTimeline?.formatContext({ scope: memoryScope(event) }) || '',
    personalLifeState?.formatContext({ scope: memoryScope(event) }) || '',
    lifeConversation?.formatContext({ scope: memoryScope(event) }) || '',
    event.lifeResumeContext || '',
    desktopContext,
    shouldInspectImages && !imagePaths.length ? '图片缓存读取失败，本轮没有视觉输入；请明确说明看不到，不根据文件名或占位文字猜测内容。' : null,
    !qqVisionAvailable ? '当前没有图片或动画表情视觉输入。上下文里的图片占位、文件名、表情编号和链接不是图片内容；严禁据此编造人物、动作、情绪或梗。遇到带图消息只回应可读文字，被问图中内容时说明看不到。' : null,
    mood.context,
    privateProfileContext,
    skillContext(installedSkills, resolveChatSkill(installedSkills, privateTasks.chatSkill(event) ?? localConfig.chatSkill)),
    "",
    memoryBlock,
    memoryBlock ? "" : null,
    quotedContext,
    quotedContext ? "" : null,
    event.replyContextError ? '被引用的消息无法读取或无法核验属于当前私聊；不要猜测引用内容，需要时请对方提供原文。' : null,
    webContext,
    webContext ? "" : null,
    !structuredLifeReply && !forceLocalReply && expandLevel === 0 ? "如果这条消息明显是在追问前文、接上一句、问刚刚发生了什么，而你拿到的最近上下文仍然不够判断，请不要硬猜，直接只输出 [[qq_context_more]] 这个标记，让 Hub 继续向前翻记录后再回答。" : null,
    expandLevel === 0 ? "" : null,
    hasAnyQqImageReference(event) && !shouldInspectImages ? "本条 QQ 消息或引用消息带了图片，但本轮没有可用的视觉输入。不要声称看过图片内容。" : null,
    shouldInspectImages ? `收到的 QQ 图片：${formatQqImageSummary(qqModelImages)}` : null,
    imagePaths.length ? `可查看的本地图片数量：${imagePaths.length}` : null,
    imagePaths.length ? "请结合图片内容回复。不要过度保守：只要能看清主元素、文字、构图或梗图大意，就先说你看到了什么并给出判断；只有完全无法辨认主体时才说看不清。" : null,
    hasAnyQqImageReference(event) ? "" : null,
    state.qq.enhancer.enabled ? "本地表情包库：" : null,
    state.qq.enhancer.enabled ? formatQqStickerCatalog(stickerCatalog) : null,
    state.qq.enhancer.enabled && stickerCatalog.length ? "表情包库可用时，部署者可以在自定义 profile 或 QQ enhancer 包中说明何时使用 [[qq_sticker:表情包名]]；只能选择提示里真实存在的表情包名。" : null,
    "",
    "收到的 QQ 私聊：",
    formatQqIncomingPromptText(event, text),
    "",
    forceLocalReply ? "不要再请求更多上下文，也不要输出任何内部标记。请基于当前消息、引用、图片和已经给到的上下文回复；如果仍缺少必要前文，直接说明没接上并请对方澄清，不要猜测。" : null,
    forceLocalReply ? "" : null,
    "请直接给出要发送到 QQ 私聊里的最终回复。不要追加服务式追问或“我还能继续帮你”的结尾。",
    structuredLifeReply ? lifeChatDecisionPrompt(boundaryEvidence?.event?.text, { allowContextMore: !forceLocalReply }) : null
  ].filter((part) => part != null).join("\n");

  await ensureCodexReplyWorkspace();
  const schemaPath = join(codexTmpDir, `${id}.schema.json`);
  if (structuredLifeReply) await writeFile(schemaPath, JSON.stringify(lifeChatDecisionSchema));

  const args = [
    "exec",
    "--ephemeral",
    "--ignore-user-config",
    "--skip-git-repo-check",
    "--ignore-rules",
    "-s",
    "read-only",
    "-m",
    event.type === 'private_message' ? (localConfig.privateChatModel || state.ai.model) : state.ai.model,
    "-c",
    `model_reasoning_effort="${event.type === 'private_message' ? (localConfig.privateChatReasoningEffort || state.ai.reasoningEffort) : state.ai.reasoningEffort}"`,
    "-C",
    codexWorkspaceDir,
    "-o",
    outputPath,
    ...(structuredLifeReply ? ['--output-schema', schemaPath] : []),
    ...imagePaths.flatMap((imagePath) => ["--image", imagePath]),
    "-"
  ];

  const combinedLifeReply = Boolean(event.lifeResumeContext);
  let prompt = await buildReplyPrompt(recalled.context, 0, combinedLifeReply);
  let cliResult = await runCodexCli(args, prompt, {
    budgetPurpose: combinedLifeReply ? 'qq-life-reply' : 'qq-chat',
    earlyReply: true,
    cwd: codexWorkspaceDir,
    timeout: 300000,
    env: {
      ...process.env,
      CODEX_REMOTE_CONTACT_QQ_MODE: "1"
    }
  });

  let lifeDecision;
  const decodeReply = raw => {
    if (!structuredLifeReply) return cleanCodexReply(raw);
    lifeDecision = parseLifeChatDecision(raw);
    return lifeDecision.contextMore ? '[[qq_context_more]]' : lifeDecision.reply;
  };
  let baseReply = decodeReply(cliResult.replyText || await readFile(outputPath, "utf8"));
  if (!combinedLifeReply && shouldRequestExpandedQqContext(stripMoodMarkers(baseReply))) {
    const record = state.qq.events.find(record => record.event === event);
    if (record?.decision) record.decision.status = '补查上下文';
    try {
      const expanded = await unifiedMemory.recall({ ...recallOptions,
        limit: 20, expanded: true, previous: recalled });
      // Retry only when the actual rendered context supplies additional evidence.
      if (expanded.hasNewEvidence && expanded.context !== recalled.context) {
        recalled = expanded;
        prompt = await buildReplyPrompt(recalled.context, 1, true);
        cliResult = await runCodexCli(args, prompt, {
          budgetPurpose: 'qq-context-expansion',
          earlyReply: true,
          cwd: codexWorkspaceDir,
          timeout: 300000,
          env: { ...process.env, CODEX_REMOTE_CONTACT_QQ_MODE: "1" }
        });
        baseReply = decodeReply(cliResult.replyText || await readFile(outputPath, "utf8"));
      }
    } catch {
      // Retrieval, quota and CLI failures must not turn missing history into a guess.
      baseReply = '这次没能补查到前文，你指的是哪一段？';
      event.skipExchangeMemory = true;
    }
  }
  if (shouldRequestExpandedQqContext(stripMoodMarkers(baseReply))) {
    baseReply = '这句的前文我没接上，你指的是哪一段？';
    event.skipExchangeMemory = true;
  }
  if (lifeDecision?.contactBoundary.kind !== 'none' && lifeDecision?.contactBoundary && boundaryEvidence) {
    const { kind, quote } = lifeDecision.contactBoundary;
    if (ownContactEvidence(boundaryEvidence.event).some(line => line.includes(quote))
      && (kind !== 'resume' || isExplicitContactInvitation(boundaryEvidence.event, quote))) {
      await lifeContacts.applyDecision({ token: boundaryEvidence.token, event: boundaryEvidence.event,
        decision: { action: kind, basis: kind === 'pause' ? 'contextual-impatience' : 'explicit-invitation',
          evidence: quote, reason: kind === 'pause' ? 'same-turn-contextual-impatience' : 'same-turn-explicit-invitation' } });
    }
    if (kind === 'pause' && !lifeContacts.isCurrent(event.lifeContactToken)) return '';
  }
  if (structuredLifeReply && !isCurrentLifeReply(event)) return '';
  baseReply = moodState.finalize(baseReply, event);
  const reply = state.qq.enhancer.enabled
    ? encourageQqStickerReply(
      baseReply,
      event,
      stickerCatalog
    )
    : baseReply;
  if (!reply) return buildAssistantReply(event);
  return reply.slice(0, 900);
}

function shouldRequestExpandedQqContext(reply) {
  return String(reply || "").includes("[[qq_context_more]]");
}

function encourageQqStickerReply(reply, event, stickerCatalog) {
  return ensureStickerLeadText(reply);
}

function isLowStickerValueReply(reply, event) {
  return false;
}

function shouldAutoAttachQqSticker(source, event) {
  return false;
}

function chooseQqStickerName(text, stickerCatalog) {
  const ranked = rankStickerNamesByText(text, stickerCatalog);
  if (ranked[0]?.score >= 5) {
    const top = ranked.filter((item) => item.score >= Math.max(5, ranked[0].score - 2)).slice(0, 5);
    return top[stableModuloLocal(`${text}:${ranked[0].name}`, top.length)]?.name || ranked[0].name;
  }

  const rules = [
    // Deployment customization point:
    // Add rules such as { pattern: /keyword/, names: ["sticker name"] } after
    // adding your own public sticker library.
  ];

  for (const rule of rules) {
    if (!rule.pattern.test(text)) continue;
    const found = findAvailableStickerName(stickerCatalog, rule.names);
    if (found) return found;
  }
  return "";
}

function rankStickerNamesByText(text, stickerCatalog) {
  const normalizedText = normalizeSemanticText(text);
  return (stickerCatalog || [])
    .map((item) => ({
      name: item.name,
      score: scoreStickerNameAgainstText(item.name, normalizedText)
    }))
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score || a.name.localeCompare(b.name, "zh-Hans-CN"));
}

function scoreStickerNameAgainstText(name, normalizedText) {
  const normalizedName = normalizeSemanticText(name);
  if (!normalizedName || !normalizedText) return 0;
  let score = 0;
  if (normalizedText.includes(normalizedName)) score += 30;
  for (const chunk of meaningfulChunks(normalizedName)) {
    if (normalizedText.includes(chunk)) score += chunk.length >= 3 ? 5 : 3;
  }
  for (const gram of charGrams(normalizedName, 2)) {
    if (normalizedText.includes(gram)) score += 1;
  }
  const boosts = [
    // Deployment customization point:
    // Add semantic boost pairs here if you want filename-based sticker ranking.
  ];
  for (const [textPattern, namePattern] of boosts) {
    if (textPattern.test(normalizedText) && namePattern.test(normalizedName)) score += 8;
  }
  return score;
}

function meaningfulChunks(text) {
  return String(text || "")
    .split(/[^一-龥A-Za-z0-9]+/)
    .flatMap((part) => {
      if ([...part].length <= 4) return [part];
      const chunks = [];
      for (let size = 4; size >= 2; size -= 1) {
        for (let index = 0; index <= [...part].length - size; index += size) {
          chunks.push([...part].slice(index, index + size).join(""));
        }
      }
      return chunks;
    })
    .filter((chunk) => [...chunk].length >= 2 && !/^(这个|那个|我们|你们|他们|就是|然后|可以|非常|已经|现在)$/.test(chunk));
}

function charGrams(text, size) {
  const chars = [...String(text || "")];
  const grams = [];
  for (let index = 0; index <= chars.length - size; index += 1) {
    grams.push(chars.slice(index, index + size).join(""));
  }
  return grams;
}

function normalizeSemanticText(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/\[\[qq_(?:sticker|image):[^\]]+\]\]/g, "")
    .replace(/\[cq:[^\]]+\]/gi, "")
    .replace(/[^\p{Script=Han}A-Za-z0-9]+/gu, "")
    .trim();
}

function findAvailableStickerName(stickerCatalog, names) {
  for (const name of names) {
    const found = stickerCatalog.find((item) => item.name === name);
    if (found) return found.name;
  }
  return "";
}

function stableModuloLocal(seed, modulo) {
  let hash = 0;
  for (const char of String(seed || "")) {
    hash = (hash * 31 + char.codePointAt(0)) >>> 0;
  }
  return modulo > 0 ? hash % modulo : 0;
}

async function buildWebLookupContext(event) {
  const text = stripMentionText(event.text);
  if (!shouldUseWebLookup(event, text)) return "";
  const query = buildWebLookupQuery(text);
  try {
    const results = await searchWeb(query);
    if (results.length === 0) return "";
    return [
      "联网查询摘要：",
      "以下是 Hub 为这个 QQ 私聊问题临时查询到的网页搜索摘要。只在相关时参考；不要编造未查到的细节；如果结果不可靠，可以说不确定。",
      ...results.map((result, index) => [
        `${index + 1}. ${result.title}`,
        result.snippet ? `摘要：${result.snippet}` : null,
        result.url ? `链接：${result.url}` : null
      ].filter(Boolean).join("\n"))
    ].join("\n");
  } catch (error) {
    return [
      "联网查询摘要：",
      `这次联网查询失败：${error.message}。如果问题依赖最新资料或陌生定义，请简短说明现在查不到。`
    ].join("\n");
  }
}

function shouldUseWebLookup(event, text) {
  const normalized = String(text || "").trim();
  if (!state.qq.webLookup.enabled || !normalized) return false;
  if (isFilesystemProbe(normalized)) return false;
  if (/(是什么意思|什么意思|啥意思|什么梗|啥梗|什么定义|定义|是谁|谁是|是什么东西|是什么|百科|查一下|搜一下|网上|最近|最新|新闻|出处|来源)/i.test(normalized)) return true;
  if (/(最好|最好用|推荐|排行|排名|强度|攻略|通关|配装|卡牌|角色|装备|技能|流派|打法|弱点|结局|路线|隐藏|解锁|mod|MOD|版本|补丁)/i.test(normalized)
    && /(游戏|手游|Steam|steam|Switch|switch|主机|东方|虹龙洞|原神|崩铁|明日方舟|碧蓝|gal|galgame|GameCube|GC|任天堂|索尼|Xbox|xbox|卡牌|角色|装备|关卡)/i.test(normalized)) {
    return true;
  }
  if (/(哪[个些]|几个|多少|为什么|怎么|如何|能不能|可以吗|对不对|是不是|有没有|靠谱吗|厉害吗|强吗)/.test(normalized)
    && /[A-Za-z0-9]{3,}|[·《》]|东方|虹龙洞|游戏|手游|番|角色|卡牌|装备|模型|软件|项目|插件|版本|系统|硬件|显卡|驱动/.test(normalized)) {
    return true;
  }
  return false;
}

function buildWebLookupQuery(text) {
  return String(text || "").trim();
}

function shouldInspectQqImages(event, text) {
  // The response gate already decided to call the model. Include the images
  // for that reply even when a sticker has no accompanying text.
  return hasAnyQqImageReference(event);
}

function getQqModelImageInputs(event, text) {
  if (!shouldInspectQqImages(event, text)) return [];
  const currentImages = Array.isArray(event.images) ? event.images : [];
  const quotedImages = Array.isArray(event.replyContext?.images) ? event.replyContext.images : [];
  if (currentImages.length > 0) return currentImages;
  if (quotedImages.length > 0) return quotedImages;
  return [];
}

function hasAnyQqImageReference(event) {
  return (Array.isArray(event.images) && event.images.length > 0)
    || (Array.isArray(event.replyContext?.images) && event.replyContext.images.length > 0);
}

function isQqImageLookRequest(text) {
  return /(看图|看一下图|看看图|这图|这个图|这张|图片|截图|表情包|图里|图上|什么图|配图|识别|看得懂|看不懂|何意味|逆天|抽象|离谱|绷不住|典中典|味太冲|评价一下|锐评|说说|怎么看|看法)/i.test(String(text || ""));
}

async function searchWeb(query) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), qqWebLookupTimeoutMs);
  const startedAt = Date.now();
  state.maintenance.webLookup.lastQuery = query;
  state.maintenance.webLookup.lastRunAt = new Date().toISOString();
  try {
    const queryVariants = buildWebQueryVariants(query);
    const wikipediaResults = [];
    const webResults = [];
    const preferredProvider = chooseWebSearchProvider();
    state.maintenance.webLookup.effectiveProvider = preferredProvider;

    if (shouldUseWikipediaForQuery(query)) {
      for (const variant of queryVariants.slice(0, 2)) {
        const hits = await searchWikipedia(variant, controller.signal).catch(() => []);
        wikipediaResults.push(...hits);
        if (wikipediaResults.length >= 2) break;
      }
    }

    await collectSearchProviderResults(preferredProvider, queryVariants, controller.signal, webResults);
    const results = mergeSearchResults([...wikipediaResults, ...webResults]).slice(0, 5);
    const enriched = await enrichWebResults(results);
    state.maintenance.webLookup.lastOk = true;
    state.maintenance.webLookup.lastError = null;
    state.maintenance.webLookup.lastDurationMs = Date.now() - startedAt;
    return enriched;
  } catch (error) {
    state.maintenance.webLookup.lastOk = false;
    state.maintenance.webLookup.lastError = error.message;
    state.maintenance.webLookup.lastDurationMs = Date.now() - startedAt;
    if (error.name === "AbortError") throw new Error("search timed out");
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

function chooseWebSearchProvider() {
  if (qqWebSearchProvider === "duckduckgo" || qqWebSearchProvider === "ddg") return "duckduckgo";
  return "duckduckgo";
}

async function collectSearchProviderResults(provider, queryVariants, signal, output) {
  state.maintenance.webLookup.effectiveProvider = provider;
  for (const variant of queryVariants.slice(0, 4)) {
    const hits = await searchDuckDuckGo(variant, signal);
    output.push(...hits);
    if (output.length >= 5) return;
  }
}

function buildWebQueryVariants(query) {
  const raw = String(query || "").trim();
  if (!raw) return [];
  const stripped = stripSearchLeadWords(raw);
  const base = stripQuestionTail(stripped);
  const variants = [
    raw,
    stripped,
    base,
    isTimeSensitiveWebQuery(raw) ? `${base} 最新` : "",
    /(攻略|配装|打法|角色|装备|技能|流派|版本|补丁)/i.test(raw) ? `${base} 攻略` : "",
    /(是什么|什么意思|什么梗|定义|出处|来源)/i.test(raw) ? `${base} 解释` : "",
    /(谁是|是谁)/i.test(raw) ? `${base} wiki` : ""
  ];
  return [...new Set(variants.map((item) => item.trim()).filter(Boolean))].slice(0, 5);
}

function shouldUseWikipediaForQuery(query) {
  return isDefinitionStyleQuery(query);
}

function isDefinitionStyleQuery(query) {
  return /(是什么意思|什么意思|啥意思|什么梗|啥梗|定义|百科|出处|来源|是什么)/i.test(String(query || ""));
}

function stripSearchLeadWords(query) {
  return String(query || "")
    .replace(/^(查一下|搜一下|帮我查一下|帮我搜一下|网上查一下|网上搜一下|给我查一下|给我搜一下|你查一下|你搜一下)\s*/i, "")
    .trim();
}

function stripQuestionTail(query) {
  return String(query || "")
    .replace(/[？?。！!，,：:]+$/g, "")
    .replace(/(是什么意思|什么意思|啥意思|什么梗|啥梗|是什么梗|什么定义|的定义是什么|定义是什么|是什么东西|是什么|是谁|谁是|出处是什么|来源是什么|最近怎么样|最新消息)$/i, "")
    .trim() || String(query || "").trim();
}

function isTimeSensitiveWebQuery(text) {
  return /(最近|最新|现在|今天|本周|本月|版本|补丁|更新|新闻|热搜|刚出|新出的|什么时候上线|什么时候更新)/i.test(String(text || ""));
}

async function searchWikipedia(query, signal) {
  const wikipediaQuery = buildWikipediaQuery(query);
  const titles = await searchWikipediaTitles(wikipediaQuery, signal, "zh");
  const fallbackTitles = titles.length > 0 ? [] : await searchWikipediaTitles(query, signal, "en");
  const candidates = [...titles, ...fallbackTitles].slice(0, 2);
  const results = [];
  for (const candidate of candidates) {
    const summary = await fetchWikipediaSummary(candidate.title, signal, candidate.lang).catch(() => null);
    if (summary?.title) results.push(summary);
  }
  return results;
}

function buildWikipediaQuery(query) {
  return stripMentionText(query)
    .replace(/[？?。！!，,：:]+$/g, "")
    .trim()
    .replace(/^(查一下|搜一下|百科一下|百科|网上查一下|帮我查一下)\s*/, "")
    .replace(/^谁是\s*/, "")
    .replace(/(是什么意思|什么意思|啥意思|什么梗|啥梗|是什么梗|什么定义|的定义是什么|定义是什么|是什么东西|是什么|是谁|谁是|出处是什么|来源是什么|最近怎么样|最新消息)$/i, "")
    .trim() || String(query || "").trim();
}

async function searchWikipediaTitles(query, signal, lang) {
  const url = `https://${lang}.wikipedia.org/w/api.php?action=opensearch&search=${encodeURIComponent(query)}&limit=3&namespace=0&format=json&origin=*`;
  const response = await fetch(url, {
    signal,
    headers: { "user-agent": userAgentName }
  });
  if (!response.ok) return [];
  const data = await response.json();
  const titles = Array.isArray(data?.[1]) ? data[1] : [];
  return titles.map((title) => ({ title, lang }));
}

async function fetchWikipediaSummary(title, signal, lang) {
  const url = `https://${lang}.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(title)}`;
  const response = await fetch(url, {
    signal,
    headers: { "user-agent": userAgentName }
  });
  if (!response.ok) return null;
  const data = await response.json();
  if (data.type === "disambiguation" && !data.extract) return null;
  return {
    title: `Wikipedia：${data.title || title}`,
    url: data.content_urls?.desktop?.page || `https://${lang}.wikipedia.org/wiki/${encodeURIComponent(title)}`,
    snippet: data.extract || "",
    source: "wikipedia"
  };
}

async function searchDuckDuckGo(query, signal) {
  const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
  const response = await fetch(url, {
    signal,
    headers: {
      "user-agent": userAgentName
    }
  });
  if (!response.ok) throw new Error(`search returned HTTP ${response.status}`);
  return parseDuckDuckGoResults(await response.text()).slice(0, 3);
}

function mergeSearchResults(results) {
  const seen = new Set();
  return results.filter((result) => {
    const key = result.url || result.title;
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

async function enrichWebResults(results) {
  const enriched = [];
  for (const result of results) {
    if (!result.snippet && result.source !== "wikipedia" && enriched.length < 2 && result.url) {
      enriched.push({
        ...result,
        snippet: await fetchPageSnippet(result.url).catch(() => "")
      });
    } else {
      enriched.push(result);
    }
  }
  return enriched;
}

async function fetchPageSnippet(url) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), Math.min(3500, qqWebLookupTimeoutMs));
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: { "user-agent": userAgentName }
    });
    if (!response.ok) return "";
    const contentType = response.headers.get("content-type") || "";
    if (!contentType.includes("text/html")) return "";
    const text = htmlToPlainText(await response.text());
    return text.slice(0, 420);
  } finally {
    clearTimeout(timeout);
  }
}

function htmlToPlainText(html) {
  return cleanHtml(String(html || "")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, " "));
}

function parseDuckDuckGoResults(html) {
  return String(html || "")
    .split(/<div class="result(?: result--ad)?/g)
    .map((block) => {
      const titleMatch = block.match(/<a[^>]*class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/);
      if (!titleMatch) return null;
      const snippetMatch = block.match(/class="result__snippet"[^>]*>([\s\S]*?)<\/(?:a|div)>/);
      return {
        title: cleanHtml(titleMatch[2]),
        url: normalizeDuckDuckGoUrl(htmlDecode(titleMatch[1])),
        snippet: snippetMatch ? cleanHtml(snippetMatch[1]) : ""
      };
    })
    .filter((result) => result?.title)
    .filter((result, index, list) => list.findIndex((item) => item.url === result.url) === index);
}

function cleanHtml(value) {
  return htmlDecode(String(value || "")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim());
}

function htmlDecode(value) {
  return String(value || "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, "\"")
    .replace(/&#39;/g, "'")
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, num) => String.fromCodePoint(Number(num)));
}

function normalizeDuckDuckGoUrl(url) {
  try {
    const parsed = new URL(url, "https://duckduckgo.com");
    const redirected = parsed.searchParams.get("uddg");
    return redirected ? decodeURIComponent(redirected) : parsed.href;
  } catch {
    return url;
  }
}

function isPrivateMemoryEvent(event) {
  return event?.type === 'private_message' && event.groupId == null && event.raw?.group_id == null
    && /^[1-9]\d*$/.test(String(event.senderId || ''));
}

async function rememberQqExchange(event, reply) {
  if (!isPrivateMemoryEvent(event) || !reply || event.skipExchangeMemory
    || /^\s*\//.test(event.text || '')) return;
  await unifiedMemory.writeExchange({ scope: memoryScope(event),
    senderLabel: event.senderLabel || String(event.senderId),
    userText: stripMentionText(event.text || ''), replyText: String(reply),
    messageId: event.raw?.message_id, replyMessageId: event.replyMessageId,
    sentMessageIds: event.sentMessageIds || [],
    quotedText: event.replyContext?.scopeVerified ? event.replyContext.text || '' : '' });
}

function sqliteJson(query) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.env.SQLITE_CLI_PATH || (isMac ? "/usr/bin/sqlite3" : "sqlite3"), ["-json", `${process.env.HOME}/Library/Messages/chat.db`, query], {
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code !== 0) {
        reject(new Error((stderr || stdout || `sqlite3 exited ${code}`).trim()));
        return;
      }
      try {
        resolve(stdout.trim() ? JSON.parse(stdout) : []);
      } catch (error) {
        reject(new Error(`Unable to parse sqlite output: ${error.message}`));
      }
    });
  });
}

function sqlString(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

function extractAttributedBodyText(hex) {
  if (!hex) return "";
  const buffer = Buffer.from(String(hex), "hex");
  const marker = Buffer.from("NSString", "utf8");
  const markerIndex = buffer.indexOf(marker);
  if (markerIndex === -1) return "";
  const plusIndex = buffer.indexOf(0x2b, markerIndex + marker.length);
  if (plusIndex === -1 || plusIndex + 1 >= buffer.length) return "";
  const length = buffer[plusIndex + 1];
  if (length <= 0 || plusIndex + 2 + length > buffer.length) return "";
  return buffer.subarray(plusIndex + 2, plusIndex + 2 + length).toString("utf8").trim();
}

async function initializeIMessageCursor() {
  const rows = await sqliteJson("select coalesce(max(ROWID), 0) as rowid from message;");
  state.imessage.lastRowId = Number(rows[0]?.rowid || 0);
  state.imessage.cursorReady = true;
  state.imessage.watchStartedAtAppleDate = currentIMessageAppleDate() - (imessageStartupGraceMs * 1_000_000);
  seenIMessageGuids.clear();
  recentIMessageReplies.clear();
  recentIMessageRequests.clear();
  state.imessage.status = "watching";
  state.imessage.lastError = null;
}

function resetIMessageCursor() {
  state.imessage.lastRowId = 0;
  state.imessage.cursorReady = false;
  state.imessage.watchStartedAtAppleDate = 0;
}

function currentIMessageAppleDate() {
  return Math.max(0, Date.now() - appleDateEpochMs) * 1_000_000;
}

function updateIMessagePoller() {
  if (serviceLifecycle?.stopping) return;
  if (!isMac) state.channels.imessage = false;
  if (!state.channels.imessage) {
    if (imessagePollTimer) clearInterval(imessagePollTimer);
    imessagePollTimer = null;
    resetIMessageCursor();
    state.imessage.status = "idle";
    return;
  }
  if (imessagePollTimer) return;
  initializeIMessageCursor().catch((error) => {
    if (shouldResetIMessageCursorOnError(error)) resetIMessageCursor();
    state.imessage.status = "error";
    state.imessage.lastError = explainIMessageError(error);
  });
  imessagePollTimer = setInterval(() => {
    pollIMessage().catch((error) => {
      if (shouldResetIMessageCursorOnError(error)) resetIMessageCursor();
      state.imessage.status = "error";
      state.imessage.lastError = explainIMessageError(error);
    });
  }, 3000);
}

function explainIMessageError(error) {
  const message = error?.message || String(error);
  if (message.includes("authorization denied") || message.includes("unable to open database")) {
    return "macOS 拒绝读取 ~/Library/Messages/chat.db，需要给运行 Chat Hub 的终端 Full Disk Access。";
  }
  return message;
}

function shouldResetIMessageCursorOnError(error) {
  const message = error?.message || String(error);
  return message.includes("authorization denied") || message.includes("unable to open database");
}

async function pollIMessage() {
  if (serviceLifecycle?.stopping || imessagePolling || !state.channels.imessage) return;
  imessagePolling = true;
  try {
    if (!state.imessage.cursorReady) {
      await initializeIMessageCursor();
      return;
    }
    const rows = await sqliteJson([
      "select message.ROWID as rowid,",
      "coalesce(message.text, '') as text,",
      "hex(message.attributedBody) as attributedBodyHex,",
      "message.is_from_me as isFromMe,",
      "coalesce(message.guid, '') as guid,",
      "coalesce(message.date, 0) as messageDate,",
      "coalesce(handle.id, '') as handle,",
      "coalesce(message.service, '') as service",
      "from message left join handle on message.handle_id = handle.ROWID",
      `where message.ROWID > ${Number(state.imessage.lastRowId || 0)}`,
      "order by message.ROWID asc limit 50;"
    ].join(" "));
    for (const row of rows) {
      state.imessage.lastRowId = Math.max(state.imessage.lastRowId, Number(row.rowid || 0));
      if (shouldIgnoreIMessageRow(row)) continue;
      const isFromMe = Number(row.isFromMe) === 1;
      const rawText = String(row.text || "").trim();
      const text = isFromMe ? rawText : rawText || extractAttributedBodyText(row.attributedBodyHex);
      if (!text && isFromMe) continue;
      if (isRecentIMessageReplyEcho(text)) {
        state.imessage.events.unshift({
          id: crypto.randomUUID(),
          receivedAt: new Date().toISOString(),
          event: {
            rowId: Number(row.rowid),
            text,
            handle: String(row.handle || ""),
            service: String(row.service || "")
          },
          trusted: true,
          result: { ok: true, summary: "Ignored own iMessage echo" },
          reply: null,
          send: null
        });
        state.imessage.events = state.imessage.events.slice(0, 30);
        continue;
      }
      if (isFromMe && !shouldHandleOwnIMessageRow(row, text)) continue;
      if (isRecentIMessageRequestDuplicate(row, text)) {
        state.imessage.events.unshift({
          id: crypto.randomUUID(),
          receivedAt: new Date().toISOString(),
          event: {
            rowId: Number(row.rowid),
            text,
            handle: String(row.handle || ""),
            service: String(row.service || "")
          },
          trusted: true,
          result: { ok: true, summary: "Ignored duplicate iMessage request" },
          reply: null,
          send: null
        });
        state.imessage.events = state.imessage.events.slice(0, 30);
        continue;
      }
      const attachments = await getIMessageAttachments(Number(row.rowid));
      const imagePaths = await Promise.all(attachments
        .filter((attachment) => attachment.isImage && attachment.exists)
        .map((attachment) => prepareIMessageModelImage(attachment.path)));
      if (!text && imagePaths.length === 0) continue;
      await handleIMessageCommand({
        rowId: Number(row.rowid),
        text: text || "对方发来了一张图片。",
        handle: String(row.handle || ""),
        service: String(row.service || ""),
        attachments,
        imagePaths
      });
    }
    state.imessage.status = "watching";
    state.imessage.lastError = null;
  } finally {
    imessagePolling = false;
  }
}

function shouldHandleOwnIMessageRow(row, text) {
  const handle = String(row.handle || "");
  if (!state.imessage.trustedHandles.includes(handle)) return false;
  if (!String(text || "").trim()) return false;
  return true;
}

function isRecentIMessageRequestDuplicate(row, text) {
  const normalized = normalizeIMessageEchoText(text);
  if (!normalized) return false;
  cleanupRecentIMessageRequests();
  const handle = String(row.handle || "");
  const isFromMe = Number(row.isFromMe) === 1 ? "me" : "them";
  const key = `${handle}:${isFromMe}:${normalized}`;
  if (recentIMessageRequests.has(key)) return true;
  recentIMessageRequests.set(key, Date.now());
  return false;
}

function cleanupRecentIMessageRequests() {
  const now = Date.now();
  for (const [key, seenAt] of recentIMessageRequests) {
    if (now - seenAt > imessageRequestDedupeTtlMs) recentIMessageRequests.delete(key);
  }
}

function shouldIgnoreIMessageRow(row) {
  const messageDate = Number(row.messageDate || 0);
  if (state.imessage.watchStartedAtAppleDate && messageDate > 0 && messageDate < state.imessage.watchStartedAtAppleDate) {
    return true;
  }
  const guid = String(row.guid || "").trim();
  if (!guid) return false;
  cleanupSeenIMessageGuids();
  if (seenIMessageGuids.has(guid)) return true;
  seenIMessageGuids.set(guid, Date.now());
  return false;
}

function cleanupSeenIMessageGuids() {
  const now = Date.now();
  for (const [guid, seenAt] of seenIMessageGuids) {
    if (now - seenAt > imessageSeenTtlMs) seenIMessageGuids.delete(guid);
  }
}

function normalizeIMessageEchoText(text) {
  return String(text || "")
    .replace(/\s+/g, " ")
    .trim();
}

function rememberIMessageReply(text) {
  const normalized = normalizeIMessageEchoText(text);
  if (!normalized) return;
  const now = Date.now();
  for (const [replyText, sentAt] of recentIMessageReplies) {
    if (now - sentAt > imessageReplyEchoTtlMs) recentIMessageReplies.delete(replyText);
  }
  recentIMessageReplies.set(normalized, now);
}

function isRecentIMessageReplyEcho(text) {
  const normalized = normalizeIMessageEchoText(text);
  if (!normalized) return false;
  const sentAt = recentIMessageReplies.get(normalized);
  if (sentAt == null) return false;
  if (Date.now() - sentAt > imessageReplyEchoTtlMs) {
    recentIMessageReplies.delete(normalized);
    return false;
  }
  return true;
}

async function getIMessageAttachments(messageRowId) {
  const rows = await sqliteJson([
    "select attachment.ROWID as id,",
    "coalesce(attachment.filename, '') as filename,",
    "coalesce(attachment.mime_type, '') as mimeType,",
    "coalesce(attachment.transfer_name, '') as transferName,",
    "coalesce(attachment.total_bytes, 0) as totalBytes",
    "from message_attachment_join join attachment on message_attachment_join.attachment_id = attachment.ROWID",
    `where message_attachment_join.message_id = ${Number(messageRowId)};`
  ].join(" "));
  const attachments = [];
  for (const row of rows) {
    const path = resolveAttachmentPath(row.filename);
    const exists = path ? await access(path).then(() => true).catch(() => false) : false;
    const mimeType = String(row.mimeType || "");
    const transferName = String(row.transferName || "");
    const isImage = mimeType.startsWith("image/") || /\.(png|jpe?g|gif|webp|heic|heif)$/i.test(path || transferName);
    attachments.push({
      id: row.id,
      path,
      filename: row.filename,
      transferName,
      mimeType,
      totalBytes: Number(row.totalBytes || 0),
      isImage,
      exists
    });
  }
  return attachments;
}

function resolveAttachmentPath(filename) {
  const raw = String(filename || "");
  if (!raw) return "";
  if (raw.startsWith("~/")) return join(userHome, raw.slice(2));
  return raw;
}

async function prepareIMessageModelImage(filePath) {
  const sourcePath = String(filePath || "").trim();
  if (!sourcePath) return "";
  await access(sourcePath);
  const extension = extname(sourcePath).toLowerCase();
  if (extension === ".png") return sourcePath;

  await mkdir(imessageScreenshotsDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const outputPath = join(imessageScreenshotsDir, `incoming-${stamp}-${crypto.randomUUID()}.png`);
  await runCommand("/usr/bin/sips", ["-s", "format", "png", sourcePath, "--out", outputPath], { timeout: 15000 });
  await runCommand("/usr/bin/xattr", ["-c", outputPath], { timeout: 5000, allowFailure: true });
  await access(outputPath);
  return outputPath;
}

async function handleIMessageCommand(event) {
  const trusted = state.imessage.trustedHandles.includes(event.handle);
  let result = { ok: false, summary: "Ignored: sender is not trusted" };
  let reply = null;
  let send = null;
  let replySent = false;
  let isSlashCommand = false;
  if (trusted) {
    try {
      expireRemoteExecutionIfIdle({ notify: false });
      const temporaryRoute = extractIMessageTemporaryCodexRoute(event.text);
      const chatEvent = temporaryRoute.hasOverrides
        ? { ...event, text: temporaryRoute.text, temporaryCodex: temporaryRoute.codex }
        : event;
      isSlashCommand = event.text.trim().startsWith("/") && !temporaryRoute.hasOverrides;
      if (isIMessageDesktopScreenshotRequest(chatEvent.text)) {
        const screenshotPath = await captureDesktopScreenshot();
        if (imessageImageDelivery === "photos") {
          const photoImport = await importImageToPhotos(screenshotPath);
          reply = `截好啦，已经放进 Mac 相册，等 iCloud 照片同步到手机就能看。\n${screenshotPath}`;
          send = await sendIMessageReply(getIMessageReplyHandle(event), reply);
          replySent = true;
          result = { ok: photoImport.ok, summary: "Desktop screenshot imported to Photos", attachmentPath: screenshotPath, photoImport };
        } else {
          reply = imessageAttachmentSendingEnabled
          ? "截好啦，发给你看。"
          : `截好了，但 iMessage 附件发送暂时关闭，避免继续卡住。\n${screenshotPath}`;
          const textSend = await sendIMessageReply(getIMessageReplyHandle(event), reply);
          replySent = true;
          if (imessageAttachmentSendingEnabled) {
            const attachmentSend = await sendIMessageAttachment(getIMessageReplyHandle(event), screenshotPath);
            send = { text: textSend, attachment: attachmentSend, attachmentPath: screenshotPath };
            result = { ok: attachmentSend.ok, summary: "Desktop screenshot sent", attachmentPath: screenshotPath };
          } else {
            send = textSend;
            result = { ok: true, summary: "Desktop screenshot captured", attachmentPath: screenshotPath };
          }
        }
      } else if (isSlashCommand) {
        result = await executeIMessageCommand(event.text, event);
        reply = result.reply || result.summary;
      } else if (temporaryRoute.hasOverrides && !temporaryRoute.hasBody) {
        reply = "临时模型指令后面要跟正文，例如：\n/5.5 /high\n请分析这个问题";
        result = { ok: false, summary: "Temporary iMessage route has no body" };
      } else if (state.remoteExecution.enabled) {
        touchRemoteExecutionActivity();
        reply = await buildRemoteExecutionReply(chatEvent);
        result = {
          ok: true,
          summary: temporaryRoute.hasOverrides
            ? `Remote execution reply generated with temporary route ${formatTemporaryCodexRouteSummary(temporaryRoute.codex)}`
            : "Remote execution reply generated"
        };
      } else {
        const unifiedMemoryContext = await prepareUnifiedMemoryForIMessage(chatEvent);
        chatEvent.unifiedMemoryDecision = unifiedMemoryContext.decision;
        chatEvent.unifiedMemoryRecallRoute = unifiedMemoryContext.recallRoute;
        event.unifiedMemoryDecision = unifiedMemoryContext.decision;
        event.unifiedMemoryRecallRoute = unifiedMemoryContext.recallRoute;
        reply = await buildIMessagePrivateReply(chatEvent, unifiedMemoryContext.promptContext, {
          suppressRollingIMessageContext: unifiedMemoryContext.recallRoute?.source?.startsWith?.("desktop")
        });
        result = {
          ok: true,
          summary: temporaryRoute.hasOverrides
            ? `Private reply generated with temporary route ${formatTemporaryCodexRouteSummary(temporaryRoute.codex)}`
            : "Private reply generated"
        };
      }
      const attachmentPaths = state.remoteExecution.enabled ? extractIMessageAttachmentMarkers(reply) : [];
      reply = stripIMessageAttachmentMarkers(reply);
      if (reply && !replySent) {
        send = await sendIMessageReply(getIMessageReplyHandle(event), reply);
        replySent = true;
      }
      if (imessageImageDelivery === "photos" && attachmentPaths.length > 0) {
        const photoImports = [];
        for (const attachmentPath of attachmentPaths) {
          photoImports.push(await importImageToPhotos(attachmentPath));
        }
        const pathNote = `截图已经放进 Mac 相册，等 iCloud 照片同步到手机就能看。\n${attachmentPaths.join("\n")}`;
        await sendIMessageReply(getIMessageReplyHandle(event), pathNote);
        result = { ...result, attachmentPaths, photoImports };
      } else if (imessageAttachmentSendingEnabled && attachmentPaths.length > 0) {
        const attachmentResults = [];
        for (const attachmentPath of attachmentPaths) {
          attachmentResults.push(await sendIMessageAttachment(getIMessageReplyHandle(event), attachmentPath));
        }
        send = { text: send, attachments: attachmentResults, attachmentPaths };
        result = { ...result, attachmentPaths };
      } else if (!imessageAttachmentSendingEnabled && attachmentPaths.length > 0) {
        const pathNote = `\n\n截图已保存，但 iMessage 附件发送暂时关闭：\n${attachmentPaths.join("\n")}`;
        await sendIMessageReply(getIMessageReplyHandle(event), pathNote.trim());
        result = { ...result, attachmentPaths, attachmentsSkipped: true };
      }
      if (result?.sleepSystem) scheduleSystemSleep();
      if (state.remoteExecution.enabled && reply && send?.ok) touchRemoteExecutionActivity();
      if (!isSlashCommand && !state.remoteExecution.enabled && reply && send?.ok) {
        await rememberIMessageTurn(chatEvent, reply);
        await applyUnifiedMemoryDecision(chatEvent, reply);
      }
    } catch (error) {
      result = { ok: false, summary: error.message };
      reply = error.code === 'RUNTIME_BUDGET_BLOCKED' ? publicFailure(error) : event.text.trim().startsWith("/")
        ? `执行失败：${error.message.slice(0, 180)}`
        : "回应超时。";
      try {
        send = await sendIMessageReply(getIMessageReplyHandle(event), reply);
      } catch (sendError) {
        send = { ok: false, error: sendError.message };
      }
    }
  }
  state.imessage.events.unshift({
    id: crypto.randomUUID(),
    receivedAt: new Date().toISOString(),
    event,
    trusted,
    result,
    reply,
    send
  });
  state.imessage.events = state.imessage.events.slice(0, 30);
}

function getIMessageReplyHandle(event) {
  return event?.handle || state.imessage.replyHandle;
}

function isIMessageDesktopScreenshotRequest(text) {
  const normalized = String(text || "").replace(/\s+/g, "");
  if (!normalized) return false;
  const hasScreenshotNoun = /(截图|截屏|截个图|截一张|拍屏|屏幕截图)/.test(normalized);
  const hasViewIntent = /(给我看看|给我看|看看|看一下|发我|发给我|发来|看下|看一眼)/.test(normalized);
  const hasDesktopScene = /(现在桌面|当前桌面|电脑桌面|屏幕上|现在屏幕|当前屏幕)/.test(normalized);
  return (hasScreenshotNoun && hasViewIntent) || hasDesktopScene;
}

function extractIMessageAttachmentMarkers(text) {
  return [...String(text || "").matchAll(/\[\[imessage_attachment:([^\]\n]+)\]\]/g)]
    .map((match) => match[1].trim())
    .filter(Boolean);
}

function stripIMessageAttachmentMarkers(text) {
  return String(text || "")
    .replace(/\[\[imessage_attachment:[^\]\n]+\]\]/g, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

async function executeIMessageCommand(text, event = null) {
  const command = String(text || "").trim().replace(/^\/+/, "");
  const normalized = command.replace(/\s+/g, "").toLowerCase();
  const remoteExecutionResult = await executeRemoteExecutionCommand(command, normalized);
  if (remoteExecutionResult) return remoteExecutionResult;
  if (/^(帮助|help|指令)$/.test(normalized)) {
    return { ok: true, summary: "Help sent", reply: [
      "可用命令：",
      "/状态",
      "/私聊模型 模型名",
      "/私聊智能等级 low|medium|high|xhigh",
      "/QQ模型 模型名",
      "/QQ智能等级 low|medium|high|xhigh",
      "/额度",
      "/刷新额度",
      "/启动Codex",
      "/前台Codex",
      "/退出Codex",
      "/维护",
      "/记忆",
      "/交接",
      "/统一记忆状态",
      "/清除统一记忆",
      "/开启QQ",
      "/关闭QQ",
      "/开启iMessage",
      "/关闭iMessage",
      "/清除记忆",
      "/联网开",
      "/联网关",
      "/代理状态",
      "/代理开",
      "/代理关",
      "/当前节点",
      "/节点列表 [关键词]",
      "/入口测速 [关键词]",
      "/节点检查",
      "/切换节点 目标",
      "/关闭背光",
      "/恢复背光",
      "/休眠",
      "/远程执行",
      "/确认",
      "/取消",
      "/帮助"
    ].join("\n") };
  }
  if (/(开启|打开|启动)qq/.test(normalized)) {
    state.channels.qq = true;
    return { ok: true, summary: "QQ channel enabled", reply: "QQ 已开启。" };
  }
  if (/(关闭|关掉|切断|停止).*(qq|监听qq)/.test(normalized) || /(qq|监听qq).*(关闭|关掉|切断|停止)/.test(normalized)) {
    state.channels.qq = false;
    return { ok: true, summary: "QQ channel disabled", reply: "QQ 已关闭。" };
  }
  if (/(开启|打开|启动)(imessage|信息|短信)/.test(normalized)) {
    state.channels.imessage = true;
    updateIMessagePoller();
    return { ok: true, summary: "iMessage channel enabled", reply: "iMessage 已开启。" };
  }
  if (/(关闭|关掉|切断|停止).*(imessage|信息|短信)/.test(normalized) || /(imessage|信息|短信).*(关闭|关掉|切断|停止)/.test(normalized)) {
    state.channels.imessage = false;
    updateIMessagePoller();
    return { ok: true, summary: "iMessage channel disabled", reply: "iMessage 已关闭。再次开启需要在 WebUI 打开，或重启 Hub 后使用默认开启状态。" };
  }
  if (/^(状态|status|查看状态)$/.test(normalized)) {
    const reply = [
      `QQ：${state.channels.qq ? "开启" : "关闭"}`,
      `QQ 模型：${state.ai.model} / ${state.ai.reasoningEffort}`,
      `iMessage：${state.channels.imessage ? "开启" : "关闭"}`,
      `iMessage 私聊模型：${state.ai.imessageModel} / ${state.ai.imessageReasoningEffort}`,
      `ban 用户：${state.qq.bannedUserIds.length} 个`,
      `iMessage 记忆：${Object.keys(state.imessage.memory.entries).length} 个联系人`,
      `远程执行模式：${state.remoteExecution.enabled ? "开启" : "关闭"}`
    ].join("\n");
    return {
      ok: true,
      summary: `QQ=${state.channels.qq ? "on" : "off"}, iMessage=${state.channels.imessage ? "on" : "off"}`,
      reply
    };
  }
  if (/^(额度|配额|quota|usage)$/.test(normalized)) {
    const health = await buildMaintenanceStatus();
    return {
      ok: true,
      summary: "Codex quota status sent",
      reply: formatCodexQuotaDetail("实时额度：", health.codex.quota)
    };
  }
  const imessageModelMatch = command.match(/^私聊模型\s+(.+)$/i);
  if (imessageModelMatch) {
    const model = imessageModelMatch[1].trim();
    if (!/^[A-Za-z0-9._:-]+$/.test(model)) {
      return { ok: false, summary: "Invalid iMessage model", reply: "这个模型名看起来不太对，只接受字母、数字、点、横线、下划线和冒号。" };
    }
    state.ai.imessageModel = model;
    await saveSettings();
    return { ok: true, summary: `iMessage model set to ${model}`, reply: `iMessage 私聊模型已切换：${model}` };
  }
  const imessageEffortMatch = command.match(/^私聊(?:智能等级|智能|思考强度)\s+(low|medium|high|xhigh|低|中|高|最高)$/i);
  if (imessageEffortMatch) {
    const effort = normalizeReasoningEffort(imessageEffortMatch[1]);
    state.ai.imessageReasoningEffort = effort;
    await saveSettings();
    return { ok: true, summary: `iMessage effort set to ${effort}`, reply: `iMessage 私聊智能等级已切换：${effort}` };
  }
  const qqModelMatch = command.match(/^qq模型\s+(.+)$/i);
  if (qqModelMatch) {
    const model = qqModelMatch[1].trim();
    if (!/^[A-Za-z0-9._:-]+$/.test(model)) {
      return { ok: false, summary: "Invalid QQ model", reply: "这个 QQ 模型名看起来不太对，只接受字母、数字、点、横线、下划线和冒号。" };
    }
    state.ai.model = model;
    await saveSettings();
    return { ok: true, summary: `QQ model set to ${model}`, reply: `QQ 通道模型已切换：${model}` };
  }
  const qqEffortMatch = command.match(/^qq(?:智能等级|智能|思考强度)\s+(low|medium|high|xhigh|低|中|高|最高)$/i);
  if (qqEffortMatch) {
    const effort = normalizeReasoningEffort(qqEffortMatch[1]);
    state.ai.reasoningEffort = effort;
    await saveSettings();
    return { ok: true, summary: `QQ effort set to ${effort}`, reply: `QQ 通道智能等级已切换：${effort}` };
  }
  if (/^(刷新额度|强刷额度|刷新配额|强刷配额)$/.test(normalized)) {
    const quota = await readLatestCodexQuotaSnapshot();
    state.maintenance.codex.quota = quota;
    return {
      ok: true,
      summary: "Codex quota forcibly refreshed",
      reply: formatCodexQuotaDetail("实时额度（强制刷新）：", quota)
    };
  }
  if (/^(启动codex|打开codex|开启codex|运行codex|startcodex|opencodex)$/.test(normalized)) {
    return startCodexDesktopApp();
  }
  if (/^(前台codex|显示codex|激活codex|bringcodexfront|focuscodex)$/.test(normalized)) {
    return activateCodexDesktopApp();
  }
  if (/^(退出codex|关闭codex|关掉codex|停止codex|quitcodex|cmdqcodex)$/.test(normalized)) {
    return quitCodexDesktopApp();
  }
  if (/^(维护|维护状态|health|statusall)$/.test(normalized)) {
    const health = await buildMaintenanceStatus();
    const proxy = await getProxyStatus();
    const reply = [
      `LLBot：${health.oneBot.ok ? "在线" : "离线"}`,
      `Codex：${health.codex.pathExists ? "路径正常" : "路径缺失"}${health.codex.lastDurationMs != null ? `，上次 ${health.codex.lastDurationMs}ms` : ""}`,
      formatCodexQuotaSummary(health.codex.quota),
      `QQ：${health.channels.qq ? "开启" : "关闭"}，事件 ${health.qq.recentEvents} 条`,
      `iMessage：${health.channels.imessage ? "开启" : "关闭"}，${health.imessage.status}`,
      `代理：${formatProxyStatus(proxy)}`,
      `联网查询：${health.webLookup.enabled ? "开启" : "关闭"}${health.webLookup.lastDurationMs != null ? `，上次 ${health.webLookup.lastDurationMs}ms` : ""}`,
      health.oneBot.lastError ? `LLBot 错误：${health.oneBot.lastError}` : null,
      health.codex.lastError ? `Codex 错误：${health.codex.lastError.slice(0, 120)}` : null,
      health.webLookup.lastError ? `联网错误：${health.webLookup.lastError}` : null,
      health.imessage.lastError ? `iMessage 错误：${health.imessage.lastError}` : null
    ].filter(Boolean).join("\n");
    return { ok: true, summary: "Maintenance status sent", reply };
  }
  const unifiedMemoryResult = await executeUnifiedMemoryCommand(command, normalized, event);
  if (unifiedMemoryResult) return unifiedMemoryResult;
  if (/^(清除记忆|清空记忆|清理记忆|重置记忆|忘记上下文)$/.test(normalized)) {
    state.imessage.memory.entries = {};
    await saveIMessageMemory();
    return { ok: true, summary: "iMessage memory cleared", reply: "iMessage 私聊记忆已清除。" };
  }
  if (/^(联网开|开启联网|打开联网|联网查询开)$/.test(normalized)) {
    state.qq.webLookup.enabled = true;
    state.maintenance.webLookup.enabled = true;
    return { ok: true, summary: "QQ web lookup enabled", reply: "QQ 联网查询已开启。" };
  }
  if (/^(联网关|关闭联网|关掉联网|联网查询关)$/.test(normalized)) {
    state.qq.webLookup.enabled = false;
    state.maintenance.webLookup.enabled = false;
    return { ok: true, summary: "QQ web lookup disabled", reply: "QQ 联网查询已关闭。" };
  }
  if (/^(代理状态|vpn状态|shadowrocket状态)$/.test(normalized)) {
    const proxy = await getProxyStatus();
    return { ok: true, summary: `Proxy ${proxy.connected ? "connected" : "disconnected"}`, reply: `代理：${formatProxyStatus(proxy)}` };
  }
  if (/^(关闭背光|关背光|低亮后台|背光关)$/.test(normalized)) {
    const result = await runCommand(backlightOffScriptPath, [], { timeout: 12000, allowFailure: true });
    return {
      ok: result.status === 0,
      summary: result.status === 0 ? "Backlight off" : "Backlight off failed",
      reply: trimIMessageCommandOutput(result.status === 0
        ? `背光已关闭，桌面会话保持运行。\n${result.output.trim()}`
        : `关闭背光失败：\n${result.output.trim()}`)
    };
  }
  if (/^(恢复背光|开背光|背光开|恢复亮度)$/.test(normalized)) {
    const result = await runCommand(backlightRestoreScriptPath, [], { timeout: 12000, allowFailure: true });
    return {
      ok: result.status === 0,
      summary: result.status === 0 ? "Backlight restored" : "Backlight restore failed",
      reply: trimIMessageCommandOutput(result.status === 0
        ? `背光已恢复。\n${result.output.trim()}`
        : `恢复背光失败：\n${result.output.trim()}`)
    };
  }
  if (/^(休眠|睡眠|立即休眠|立刻休眠|马上休眠)$/.test(normalized)) {
    return {
      ok: true,
      summary: "System sleep scheduled",
      reply: "已休眠电脑。Hub 进入待机状态，需要重新登录Mac以恢复连接。",
      sleepSystem: true
    };
  }
  if (/^(当前节点|节点状态|小火箭节点|shadowrocket节点)$/.test(normalized)) {
    return runShadowrocketNodeCommand("current");
  }
  const nodeListMatch = command.match(/^(?:节点列表|列节点|小火箭节点列表)(?:\s+(.+))?$/i);
  if (nodeListMatch) {
    return runShadowrocketNodeCommand("list", nodeListMatch[1] || "");
  }
  const nodeProbeMatch = command.match(/^(?:入口测速|节点入口测速|节点探测)(?:\s+(.+))?$/i);
  if (nodeProbeMatch) {
    return runShadowrocketNodeCommand("probe", nodeProbeMatch[1] || "");
  }
  if (/^(代理检查|节点检查|路线检查|routecheck)$/i.test(command.trim()) || /^(代理检查|节点检查|线路检查)$/.test(normalized)) {
    return runShadowrocketNodeCommand("check");
  }
  const nodeSwitchMatch = command.match(/^(?:切换节点|准备切换节点|切换节点准备|准备节点|节点准备)\s+(.+)$/i);
  if (nodeSwitchMatch) {
    return prepareShadowrocketNodeSwitch(nodeSwitchMatch[1].trim());
  }
  if (/^(代理开|开启代理|打开代理|vpn开|开启vpn|打开vpn)$/.test(normalized)) {
    return prepareProxyAction("on");
  }
  if (/^(代理关|关闭代理|关掉代理|vpn关|关闭vpn|关掉vpn)$/.test(normalized)) {
    return prepareProxyAction("off");
  }
  if (/^(取消|取消远程执行|取消远程执行模式)$/.test(normalized) && state.remoteExecution.pendingAction) {
    state.remoteExecution.pendingAction = null;
    return { ok: true, summary: "Remote execution action cancelled", reply: "远程执行模式操作已取消。" };
  }
  if (/^(取消|取消代理|取消vpn|取消代理操作)$/.test(normalized)) {
    if (state.unifiedMemoryPendingClear) {
      state.unifiedMemoryPendingClear = null;
      return { ok: true, summary: "Unified memory clear cancelled", reply: "统一记忆清除操作已取消。" };
    }
    if (state.remoteExecution.pendingAction) {
      state.remoteExecution.pendingAction = null;
      return { ok: true, summary: "Remote execution action cancelled", reply: "远程执行模式操作已取消。" };
    }
    state.proxy.pendingAction = null;
    return { ok: true, summary: "Proxy action cancelled", reply: "代理操作已取消。" };
  }
  if (/^(确认|确认代理|确认vpn|执行代理操作)$/.test(normalized)) {
    if (state.unifiedMemoryPendingClear && normalized === "确认") {
      return executePendingUnifiedMemoryClear();
    }
    if (state.remoteExecution.pendingAction && state.proxy.pendingAction && normalized === "确认") {
      return { ok: false, summary: "Ambiguous confirmation", reply: "现在同时有远程执行模式和代理操作待确认，请发送 /确认远程执行 或 /确认代理。" };
    }
    if (state.remoteExecution.pendingAction && /^(确认|确认远程执行|执行远程执行)$/.test(normalized)) {
      return executePendingRemoteExecutionAction();
    }
    return executePendingProxyAction();
  }
  return { ok: false, summary: "Unknown command", reply: "没认出这个指令。可用：/状态、/额度、/刷新额度、/启动Codex、/前台Codex、/退出Codex、/维护、/记忆、/交接、/开启QQ、/关闭QQ、/清除记忆、/代理状态、/代理开、/代理关、/联网开、/联网关、/休眠、/帮助。" };
}

async function executeUnifiedMemoryCommand(command, normalized, event) {
  if (/^(记忆|统一记忆)$/.test(normalized)) {
    const snapshot = await unifiedMemory.read({ query: command.replace(/^(记忆|统一记忆)\s*/, ""), limit: 6 });
    return { ok: true, summary: "Unified memory sent", reply: formatUnifiedMemoryForIMessage(snapshot) };
  }
  if (/^(统一记忆状态|记忆状态)$/.test(normalized)) {
    const status = await unifiedMemory.status();
    return { ok: true, summary: "Unified memory status sent", reply: formatUnifiedMemoryStatus(status) };
  }
  if (/^(交接|生成交接|写入交接)$/.test(normalized)) {
    if (!state.unifiedMemory.manualHandoffCommand) {
      return { ok: false, summary: "Manual unified handoff disabled", reply: "统一记忆的手动 /交接 写入现在是关闭的。" };
    }
    const context = formatIMessageMemoryContext(event?.handle);
    const summary = await buildUnifiedMemoryHandoffSummary(event?.text || "", context);
    const writeResult = await unifiedMemory.write({
      type: "handoff",
      source: "imessage",
      channel: "imessage",
      originDevice: "mobile_or_messages",
      executionDevice: "desktop",
      mode: "imessage_command",
      topic: "iMessage 到桌面交接",
      summary,
      sourceTextHint: event?.text || "",
      confidence: 0.86,
      zone: "base"
    });
    return { ok: writeResult.ok, summary: "Unified handoff written", reply: `交接已写入统一记忆。\n${summary}` };
  }
  if (/^(清除统一记忆|清空统一记忆|重置统一记忆)$/.test(normalized)) {
    state.unifiedMemoryPendingClear = { createdAt: Date.now() };
    return { ok: true, summary: "Unified memory clear confirmation required", reply: "准备清除统一记忆。3 分钟内发送 /确认 执行，或 /取消。" };
  }
  return null;
}

async function executePendingUnifiedMemoryClear() {
  if (!state.unifiedMemoryPendingClear) {
    return { ok: false, summary: "No pending unified memory clear", reply: "现在没有待确认的统一记忆清除操作。" };
  }
  if (Date.now() - state.unifiedMemoryPendingClear.createdAt > proxyConfirmTtlMs) {
    state.unifiedMemoryPendingClear = null;
    return { ok: false, summary: "Unified memory clear expired", reply: "统一记忆清除确认已过期。" };
  }
  state.unifiedMemoryPendingClear = null;
  await unifiedMemory.clear({ scope: "all" });
  return { ok: true, summary: "Unified memory cleared", reply: "统一记忆已清空。" };
}

function formatUnifiedMemoryForIMessage(snapshot) {
  const lines = [];
  if (snapshot.latestHandoff?.summary) {
    lines.push(`最近交接：${snapshot.latestHandoff.summary}`);
  }
  const stateParts = formatUnifiedMemoryStateParts(snapshot.currentState);
  if (stateParts.length) lines.push(`近期状态：${stateParts.join("；")}`);
  for (const entry of snapshot.entries || []) {
    lines.push(`${entry.summary}`);
  }
  if (!lines.length) return "统一记忆现在还是空的。";
  return [`统一记忆：`, ...[...new Set(lines)].slice(0, 8)].join("\n");
}

function formatUnifiedMemoryStatus(status) {
  const counts = status.counts || {};
  const stateParts = formatUnifiedMemoryStateParts(status.currentState);
  return [
    "统一记忆状态：",
    `更新时间：${status.updatedAt || "暂无"}`,
    `电脑端 skill 自动写入：${state.unifiedMemory.autoWriteOnSkillRecall ? "开" : "关"}`,
    `iMessage 回看自动写入：${state.unifiedMemory.autoWriteOnIMessageRecall ? "开" : "关"}`,
    `/交接 手动写入：${state.unifiedMemory.manualHandoffCommand ? "开" : "关"}`,
    `交接：${counts.handoffHistory || 0} 条`,
    `点子：${counts.ideas || 0} 条`,
    `项目：${counts.projectNotes || 0} 条`,
    `待办：${counts.openLoops || 0} 条`,
    `日常状态：${counts.dailyTimeline || 0} 条`,
    stateParts.length ? `近期状态：${stateParts.join("；")}` : null
  ].filter(Boolean).join("\n");
}

function formatCodexQuotaSummary(quota) {
  if (!quota?.available) return null;
  const parts = [];
  if (quota.primary) {
    parts.push(`5小时剩余 ${formatQuotaPercent(quota.primary.remainingPercent)}（重置 ${formatQuotaResetTime(quota.primary.resetsAt)}）`);
  }
  if (quota.secondary) {
    parts.push(`7天剩余 ${formatQuotaPercent(quota.secondary.remainingPercent)}（重置 ${formatQuotaResetTime(quota.secondary.resetsAt)}）`);
  }
  if (quota.totalTokens != null && quota.modelContextWindow != null) {
    parts.push(`已使用 ${formatLocaleNumber(quota.totalTokens)} / 共 ${formatContextWindow(quota.modelContextWindow)}`);
  }
  return parts.length ? `额度：${parts.join("；")}` : null;
}

function formatCodexQuotaDetail(title, quota) {
  if (!quota?.available) {
    return [title, quota?.lastError || "暂时还没读到 Codex 的额度记录。"].join("\n");
  }
  return [
    title,
    quota.primary ? `5小时 ${formatQuotaBar(quota.primary.remainingPercent)} ${formatQuotaPercent(quota.primary.remainingPercent)}` : null,
    quota.primary ? `(重置 ${formatQuotaResetTime(quota.primary.resetsAt)}）` : null,
    quota.secondary ? `7天 ${formatQuotaBar(quota.secondary.remainingPercent)} ${formatQuotaPercent(quota.secondary.remainingPercent)}` : null,
    quota.secondary ? `（重置 ${formatQuotaResetTime(quota.secondary.resetsAt)}）` : null,
    quota.totalTokens != null && quota.modelContextWindow != null
      ? `已使用 ${formatLocaleNumber(quota.totalTokens)} / 共 ${formatContextWindow(quota.modelContextWindow)}`
      : null,
    quota.updatedAt ? `同步时间：${new Date(quota.updatedAt).toLocaleString("zh-CN")}` : null
  ].filter(Boolean).join("\n");
}

function formatQuotaPercent(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return "--";
  return `${Math.round(numeric)}%`;
}

function formatQuotaResetTime(epochSeconds) {
  const date = new Date(Number(epochSeconds) * 1000);
  if (Number.isNaN(date.getTime())) return "未知";
  const now = new Date();
  const sameDate = date.getFullYear() === now.getFullYear()
    && date.getMonth() === now.getMonth()
    && date.getDate() === now.getDate();
  return sameDate
    ? date.toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" })
    : date.toLocaleDateString("zh-CN", { month: "numeric", day: "numeric" });
}

function formatLocaleNumber(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return "--";
  return Math.round(numeric).toLocaleString("en-US");
}

function formatContextWindow(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return "--";
  if (numeric >= 1000) return `${Math.round(numeric / 1000)}K`;
  return `${Math.round(numeric)}`;
}

function formatQuotaBar(value) {
  const numeric = Number(value);
  const clamped = Number.isFinite(numeric)
    ? Math.max(0, Math.min(100, numeric))
    : 0;

  const total = 15;
  const filled = Math.round((clamped / 100) * total);

  return `${"■".repeat(filled)}${"□".repeat(total - filled)}`;
}

function formatUnifiedMemoryStateParts(currentState = {}) {
  return [
    currentState.timeContext,
    currentState.sleepState,
    currentState.recentMeal,
    currentState.bodyState,
    currentState.mood
  ].filter(Boolean);
}

async function buildUnifiedMemoryHandoffSummary(commandText, imessageContext) {
  const fallback = summarizeIMessageContextForHandoff(commandText, imessageContext);
  if (!imessageContext) return fallback;
  try {
    const id = crypto.randomUUID();
    const outputPath = join(codexTmpDir, `${id}.unified-memory-handoff.txt`);
    await ensureCodexReplyWorkspace();
    const prompt = [
      "请把以下 iMessage 私聊上下文提炼成一条给桌面 Codex CLI 接力用的统一记忆交接摘要。",
      "只输出 1 到 3 句中文，不要标题，不要 Markdown。",
      "保留当前主题、最近状态、下一步；不要保存隐私敏感值。",
      "",
      "触发命令：",
      commandText,
      "",
      "上下文：",
      imessageContext.slice(-6000)
    ].join("\n");
    const args = [
      "exec",
      "--ephemeral",
      "--ignore-user-config",
      "--skip-git-repo-check",
      "--ignore-rules",
      "-s",
      "read-only",
      "-m",
      codexModel,
      "-c",
      `model_reasoning_effort="${codexReasoningEffort}"`,
      "-C",
      codexWorkspaceDir,
      "-o",
      outputPath,
      "-"
    ];
    await runCodexCli(args, prompt, {
      cwd: codexWorkspaceDir,
      timeout: 60000,
      env: {
        ...process.env,
        CODEX_REMOTE_CONTACT_UNIFIED_MEMORY_HANDOFF: "1"
      }, budgetPurpose: 'memory-handoff'
    });
    return cleanCodexReply(await readFile(outputPath, "utf8")).slice(0, 800) || fallback;
  } catch {
    return fallback;
  }
}

function summarizeIMessageContextForHandoff(commandText, imessageContext) {
  const lines = String(imessageContext || "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(-8);
  if (!lines.length) return String(commandText || "iMessage 端请求生成交接。").slice(0, 500);
  return lines.join("；").slice(0, 700);
}

async function prepareProxyAction(action) {
  const proxy = await getProxyStatus();
  const wantsOn = action === "on";
  if (proxy.connected === wantsOn) {
    return {
      ok: true,
      summary: `Proxy already ${wantsOn ? "on" : "off"}`,
      reply: `代理已经是${wantsOn ? "开启" : "关闭"}状态。\n${formatProxyStatus(proxy)}`
    };
  }
  state.proxy.pendingAction = {
    action,
    createdAt: Date.now()
  };
  return {
    ok: true,
    summary: `Proxy ${action} confirmation required`,
    reply: [
      `准备${wantsOn ? "开启" : "关闭"}代理。`,
      "这会切换本机 Shadowrocket/VPN 状态。",
      "如果确认执行，请在 3 分钟内发送 /确认；不执行就发送 /取消。"
    ].join("\n")
  };
}

async function runShadowrocketNodeCommand(command, argument = "") {
  const args = [command];
  if (argument) args.push(argument);
  const result = await runCommand(shadowrocketNodeControlPath, args, { timeout: command === "check" ? 15000 : 8000, allowFailure: true });
  const output = result.output.trim();
  return {
    ok: result.status === 0,
    summary: result.status === 0 ? `Shadowrocket node ${command}` : `Shadowrocket node ${command} failed`,
    reply: trimIMessageCommandOutput(output || `节点命令没有输出：${command}`)
  };
}

async function prepareShadowrocketNodeSwitch(target) {
  const resolved = await runCommand(shadowrocketNodeControlPath, ["resolve", target], { timeout: 8000, allowFailure: true });
  if (resolved.status !== 0) {
    return {
      ok: false,
      summary: "Shadowrocket node resolve failed",
      reply: trimIMessageCommandOutput(`没找到这个节点：${target}\n${resolved.output.trim()}`)
    };
  }
  const node = JSON.parse(resolved.output.trim());
  const probe = await runCommand(shadowrocketNodeControlPath, ["probe-target", String(node.index || node.uuid)], { timeout: 8000, allowFailure: true });
  state.proxy.pendingAction = {
    action: "switch-node",
    target: String(node.index || node.uuid),
    node,
    createdAt: Date.now()
  };
  return {
    ok: true,
    summary: "Shadowrocket node switch confirmation required",
    reply: trimIMessageCommandOutput([
      "准备切换 Shadowrocket 节点。",
      `目标：${node.index}. ${node.title}`,
      `类型：${node.type || "未知"}，小火箭 ping：${node.ping ?? "未知"}`,
      `入口：${node.host || "未知"}:${node.port || "未知"}`,
      "",
      "准备阶段入口测速：",
      probe.output.trim() || "入口测速没有输出。",
      "",
      "注意：这里只测目标入口 TCP，不代表目标节点一定能访问 OpenAI/X/YouTube。",
      "确认切换请在 3 分钟内发送 /确认；不切换就发送 /取消。"
    ].join("\n"))
  };
}

function trimIMessageCommandOutput(text, limit = 1600) {
  const value = String(text || "").trim();
  if (value.length <= limit) return value;
  return `${value.slice(0, limit - 40)}\n...（输出已截断）`;
}

async function executePendingProxyAction() {
  const pending = state.proxy.pendingAction;
  if (!pending) {
    return { ok: false, summary: "No pending proxy action", reply: "现在没有待确认的代理操作。" };
  }
  if (Date.now() - pending.createdAt > proxyConfirmTtlMs) {
    state.proxy.pendingAction = null;
    return { ok: false, summary: "Proxy action expired", reply: "代理操作确认已过期，请重新发送 /代理开 或 /代理关。" };
  }

  if (pending.action === "switch-node") {
    const target = pending.target;
    const node = pending.node || {};
    const result = await runCommand(shadowrocketNodeControlPath, ["switch", target], { timeout: 30000, allowFailure: true });
    state.proxy.pendingAction = null;
    return {
      ok: result.status === 0,
      summary: result.status === 0 ? "Shadowrocket node switched" : "Shadowrocket node switch failed",
      reply: trimIMessageCommandOutput([
        result.status === 0 ? "节点切换已执行。" : "节点切换失败。",
        node.title ? `目标：${node.title}` : null,
        result.output.trim()
      ].filter(Boolean).join("\n"))
    };
  }

  const wantsOn = pending.action === "on";
  const before = await getProxyStatus();
  if (before.connected === wantsOn) {
    state.proxy.pendingAction = null;
    return {
      ok: true,
      summary: `Proxy already ${wantsOn ? "on" : "off"}`,
      reply: `代理已经是${wantsOn ? "开启" : "关闭"}状态。\n${formatProxyStatus(before)}`
    };
  }

  await runCommand("/usr/sbin/scutil", ["--nc", wantsOn ? "start" : "stop", "Shadowrocket"], { timeout: 30000 });
  await sleep(2000);
  const after = await getProxyStatus();
  state.proxy.pendingAction = null;
  const ok = after.connected === wantsOn;
  return {
    ok,
    summary: ok ? `Proxy switched ${pending.action}` : "Proxy shortcut ran but state did not match",
    reply: [
      ok ? `代理已${wantsOn ? "开启" : "关闭"}。` : "快捷指令已经执行，但代理状态没有变成预期结果。",
      formatProxyStatus(after)
    ].join("\n")
  };
}

async function getProxyStatus() {
  try {
    const result = await runCommand("/usr/sbin/scutil", ["--nc", "status", "Shadowrocket"], { timeout: 8000, allowFailure: true });
    const output = result.output.trim();
    const firstLine = output.split(/\r?\n/)[0] || "Unknown";
    return {
      ok: result.status === 0 || output.length > 0,
      connected: /^Connected$/i.test(firstLine),
      rawStatus: firstLine,
      detail: output
    };
  } catch (error) {
    return {
      ok: false,
      connected: false,
      rawStatus: "Error",
      error: error.message
    };
  }
}

function formatProxyStatus(proxy) {
  if (!proxy.ok) return `未知（${proxy.error || proxy.rawStatus || "无法读取"}）`;
  const label = proxy.connected ? "已连接" : "未连接";
  return `${label}（Shadowrocket：${proxy.rawStatus}）`;
}

async function executeRemoteExecutionCommand(command, normalized) {
  if (/^(远程执行|远程执行模式|开启远程执行|打开远程执行|启动远程执行)$/.test(normalized)) {
    if (state.remoteExecution.enabled) {
      touchRemoteExecutionActivity();
      return { ok: true, summary: "Remote execution already enabled", reply: formatRemoteExecutionStatus("远程执行模式已经开启。") };
    }
    state.remoteExecution.pendingAction = {
      action: "enable",
      createdAt: Date.now()
    };
    return {
      ok: true,
      summary: "Remote execution confirmation required",
      reply: [
        "准备开启远程执行模式。",
        "确认后会启用完整 Codex CLI 通道，并使用独立远程执行记忆。",
        "3 分钟内发送 /确认 开启，或 /取消。"
      ].join("\n")
    };
  }

  if (!state.remoteExecution.enabled) {
    if (/^(模型|智能等级|skill|skill列表|skill无|退出|续时)$/.test(normalized)) {
      return { ok: false, summary: "Remote execution command outside mode", reply: "这个命令只在远程执行模式下可用。发送 /远程执行 后再用就行。" };
    }
    if (/^(确认远程执行|执行远程执行)$/.test(normalized)) return executePendingRemoteExecutionAction();
    return null;
  }

  touchRemoteExecutionActivity();

  if (/^(帮助|help|指令)$/.test(normalized)) {
    return { ok: true, summary: "Remote execution help sent", reply: formatRemoteExecutionHelp() };
  }
  if (/^(状态|status|远程执行状态)$/.test(normalized)) {
    return { ok: true, summary: "Remote execution status sent", reply: formatRemoteExecutionStatus("远程执行模式状态：") };
  }
  if (/^(退出|关闭远程执行|退出远程执行|关闭远程执行模式|退出远程执行模式)$/.test(normalized)) {
    state.remoteExecution.enabled = false;
    state.remoteExecution.pendingAction = null;
    stopRemoteExecutionIdleTimer();
    return { ok: true, summary: "Remote execution disabled", reply: "远程执行模式已关闭。" };
  }
  if (/^(续时|续期|刷新倒计时)$/.test(normalized)) {
    touchRemoteExecutionActivity();
    return { ok: true, summary: "Remote execution timer refreshed", reply: "远程执行模式倒计时已刷新。" };
  }
  if (/^(清空记忆|清除记忆|清理记忆|重置记忆)$/.test(normalized)) {
    state.remoteExecution.memory.entries = [];
    await saveRemoteExecutionMemory();
    return { ok: true, summary: "Remote execution memory cleared", reply: "远程执行模式记忆已清空。" };
  }
  if (/^skill\s*列表$/i.test(command.trim())) {
    return {
      ok: true,
      summary: "Remote execution skill list sent",
      reply: [
        "可用 skill：",
        ...Object.keys(getRemoteExecutionSkillRegistry()).filter((name, index, all) => all.indexOf(name) === index),
        "none"
      ].join("\n")
    };
  }
  if (/^(skill无|skill关闭|skillnone|skilloff)$/i.test(normalized)) {
    state.remoteExecution.skill = "none";
    await saveSettings();
    return { ok: true, summary: "Remote execution skill cleared", reply: "远程执行模式 Skill 已关闭。" };
  }

  const skillMatch = command.match(/^skill\s+(.+)$/i);
  if (skillMatch) {
    const skill = skillMatch[1].trim();
    if (!isValidRemoteExecutionSkill(skill)) {
      return { ok: false, summary: "Unknown remote execution skill", reply: `没有这个可用 skill：${skill}\n发送 /skill列表 可以查看。` };
    }
    state.remoteExecution.skill = skill;
    await saveSettings();
    return { ok: true, summary: `Remote execution skill set to ${skill}`, reply: `远程执行模式 Skill 已切换：${skill}` };
  }

  const modelMatch = command.match(/^模型\s+(.+)$/);
  if (modelMatch) {
    const model = modelMatch[1].trim();
    if (!/^[A-Za-z0-9._:-]+$/.test(model)) {
      return { ok: false, summary: "Invalid model name", reply: "模型名看起来不太对，只接受字母、数字、点、横线、下划线和冒号。" };
    }
    state.remoteExecution.model = model;
    await saveSettings();
    return { ok: true, summary: `Remote execution model set to ${model}`, reply: `远程执行模式模型已切换：${model}` };
  }

  const effortMatch = command.match(/^(?:智能等级|智能|思考强度)\s+(low|medium|high|xhigh|低|中|高|最高)$/i);
  if (effortMatch) {
    const effort = normalizeReasoningEffort(effortMatch[1]);
    state.remoteExecution.reasoningEffort = effort;
    await saveSettings();
    return { ok: true, summary: `Remote execution effort set to ${effort}`, reply: `远程执行模式智能等级已切换：${effort}` };
  }

  return null;
}

function normalizeReasoningEffort(value) {
  const normalized = String(value || "").trim().toLowerCase();
  if (normalized === "低") return "low";
  if (normalized === "中") return "medium";
  if (normalized === "高") return "high";
  if (normalized === "最高") return "xhigh";
  return normalized;
}

function extractIMessageTemporaryCodexRoute(text) {
  const original = String(text || "");
  const lines = original.split(/\r?\n/);
  const codex = {};
  let start = 0;
  let end = lines.length - 1;
  let hasOverrides = false;

  while (start <= end && !lines[start].trim()) start += 1;
  while (end >= start && !lines[end].trim()) end -= 1;

  const leading = parseIMessageTemporaryDirectiveLine(lines[start]);
  if (leading.ok) {
    Object.assign(codex, leading.codex);
    hasOverrides = true;
    start += 1;
    while (start <= end && !lines[start].trim()) start += 1;
  }

  const trailing = parseIMessageTemporaryDirectiveLine(lines[end]);
  if (trailing.ok) {
    Object.assign(codex, trailing.codex);
    hasOverrides = true;
    end -= 1;
    while (end >= start && !lines[end].trim()) end -= 1;
  }

  const stripped = start <= end ? lines.slice(start, end + 1).join("\n").trim() : "";
  return {
    hasOverrides,
    hasBody: Boolean(stripped),
    text: hasOverrides ? stripped : original,
    codex
  };
}

function parseIMessageTemporaryDirectiveLine(line) {
  const tokens = String(line || "").trim().split(/\s+/).filter(Boolean);
  if (!tokens.length || tokens.some((token) => !token.startsWith("/"))) return { ok: false, codex: {} };
  const codex = {};
  for (const token of tokens) {
    const model = resolveIMessageTemporaryModelToken(token);
    if (model) {
      codex.model = model;
      continue;
    }
    const effort = resolveIMessageTemporaryEffortToken(token);
    if (effort) {
      codex.reasoningEffort = effort;
      continue;
    }
    return { ok: false, codex: {} };
  }
  return Object.keys(codex).length ? { ok: true, codex } : { ok: false, codex: {} };
}

function resolveIMessageTemporaryModelToken(token) {
  const raw = String(token || "").trim().replace(/^\/+/, "");
  const normalized = raw.toLowerCase();
  const aliases = {
    "5": "gpt-5",
    "5.5": "gpt-5.5",
    "5.4": "gpt-5.4",
    "5.4-mini": "gpt-5.4-mini",
    "mini": "gpt-5.4-mini",
    "5.3": "gpt-5.3-codex",
    "5.3-codex": "gpt-5.3-codex",
    "codex": "gpt-5.3-codex"
  };
  if (aliases[normalized]) return aliases[normalized];
  if (/^gpt-[A-Za-z0-9._:-]+$/.test(raw)) return raw;
  return "";
}

function resolveIMessageTemporaryEffortToken(token) {
  const raw = String(token || "").trim().replace(/^\/+/, "");
  const effort = normalizeReasoningEffort(raw);
  return isValidReasoningEffort(effort) ? effort : "";
}

function formatTemporaryCodexRouteSummary(codex = {}) {
  return [
    codex.model ? `model=${codex.model}` : null,
    codex.reasoningEffort ? `effort=${codex.reasoningEffort}` : null
  ].filter(Boolean).join(", ") || "default";
}

async function executePendingRemoteExecutionAction() {
  const pending = state.remoteExecution.pendingAction;
  if (!pending) {
    return { ok: false, summary: "No pending remote execution action", reply: "现在没有待确认的远程执行模式操作。" };
  }
  if (Date.now() - pending.createdAt > proxyConfirmTtlMs) {
    state.remoteExecution.pendingAction = null;
    return { ok: false, summary: "Remote execution action expired", reply: "远程执行模式确认已过期，请重新发送 /远程执行。" };
  }
  state.remoteExecution.enabled = true;
  state.remoteExecution.pendingAction = null;
  touchRemoteExecutionActivity();
  startRemoteExecutionIdleTimer();
  return { ok: true, summary: "Remote execution enabled", reply: formatRemoteExecutionStatus("远程执行模式开启。") };
}

function formatRemoteExecutionStatus(header) {
  return [
    header,
    `当前模型：${state.remoteExecution.model}`,
    `智能等级：${state.remoteExecution.reasoningEffort}`,
    `Skill：${state.remoteExecution.skill}`,
    `记忆：独立远程执行记忆（${state.remoteExecution.memory.entries.length} 条）`,
    "统一记忆：已接入（会读取最近交接，并在实质工作后写入进度）",
    `空闲关闭：${Math.round(state.remoteExecution.idleTtlMs / 60000)} 分钟`,
    "",
    "可用命令：",
    "/帮助 /状态 /退出",
    "/模型 模型名",
    "/智能等级 low|medium|high|xhigh",
    "/skill列表",
    "/skill skill名",
    "/skill无",
    "/清空记忆",
    "/续时"
  ].join("\n");
}

function formatRemoteExecutionHelp() {
  return [
    "远程执行模式命令：",
    "/状态",
    "/退出",
    "/模型 gpt-5.4",
    "/智能等级 medium",
    "/skill列表",
    "/skill custom-skill",
    "/skill无",
    "/清空记忆",
    "/续时",
    "",
    "在远程执行模式里，普通消息会交给完整 Codex CLI 通道处理。"
  ].join("\n");
}

function touchRemoteExecutionActivity() {
  state.remoteExecution.lastActivityAt = Date.now();
}

function startRemoteExecutionIdleTimer() {
  if (serviceLifecycle?.stopping || remoteExecutionIdleTimer) return;
  remoteExecutionIdleTimer = setInterval(() => {
    if (serviceLifecycle?.stopping) return;
    backgroundTask(expireRemoteExecutionIfIdle({ notify: true })).catch((error) => {
      state.maintenance.codex.lastError = `Remote execution idle timer failed: ${error.message}`;
    });
  }, 30 * 1000);
}

function stopRemoteExecutionIdleTimer() {
  if (remoteExecutionIdleTimer) clearInterval(remoteExecutionIdleTimer);
  remoteExecutionIdleTimer = null;
}

async function expireRemoteExecutionIfIdle({ notify }) {
  if (!state.remoteExecution.enabled || state.remoteExecution.busy) return false;
  const lastActivityAt = Number(state.remoteExecution.lastActivityAt || 0);
  if (!lastActivityAt || Date.now() - lastActivityAt <= state.remoteExecution.idleTtlMs) return false;
  state.remoteExecution.enabled = false;
  state.remoteExecution.pendingAction = null;
  stopRemoteExecutionIdleTimer();
  if (notify && state.imessage.replyHandle) {
    await sendIMessageReply(state.imessage.replyHandle, `远程执行模式已因 ${Math.round(state.remoteExecution.idleTtlMs / 60000)} 分钟无对话自动关闭。`);
  }
  return true;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function isCodexDesktopAppRunning() {
  const result = await runCommand("/usr/bin/pgrep", ["-x", "Codex"], { timeout: 5000, allowFailure: true });
  return result.status === 0 && /\d/.test(result.output);
}

async function activateCodexDesktopApp() {
  if (!await isCodexDesktopAppRunning()) {
    return startCodexDesktopApp();
  }

  await runCommand("/usr/bin/open", ["-a", "Codex"], { timeout: 12000, allowFailure: true });
  await runCommand("/usr/bin/osascript", ["-e", 'tell application "Codex" to activate'], { timeout: 12000, allowFailure: true });
  await sleep(1200);
  const quota = await readLatestCodexQuotaSnapshot().catch(() => state.maintenance.codex.quota);
  if (quota) state.maintenance.codex.quota = quota;
  return {
    ok: true,
    summary: "Codex desktop activated",
    reply: quota
      ? `Codex 已切到前台。\n\n${formatCodexQuotaDetail("实时额度：", quota)}`
      : "Codex 已切到前台。"
  };
}

async function startCodexDesktopApp() {
  if (await isCodexDesktopAppRunning()) {
    return activateCodexDesktopApp();
  }

  await runCommand("/usr/bin/open", ["-a", "Codex"], { timeout: 12000 });
  await runCommand("/usr/bin/osascript", ["-e", 'tell application "Codex" to activate'], { timeout: 12000, allowFailure: true });
  await sleep(2200);
  const running = await isCodexDesktopAppRunning();
  const quota = await readLatestCodexQuotaSnapshot().catch(() => state.maintenance.codex.quota);
  if (quota) state.maintenance.codex.quota = quota;
  return {
    ok: running,
    summary: running ? "Codex desktop started" : "Codex desktop start pending",
    reply: running
      ? quota
        ? `Codex 已启动。\n\n${formatCodexQuotaDetail("实时额度：", quota)}`
        : "Codex 已启动。"
      : "Codex 启动命令已经发出，你可以稍等一会儿再发 /刷新额度。"
  };
}

async function quitCodexDesktopApp() {
  if (!await isCodexDesktopAppRunning()) {
    return {
      ok: true,
      summary: "Codex desktop already stopped",
      reply: "Codex 现在本来就是关闭的。"
    };
  }

  const quota = await readLatestCodexQuotaSnapshot().catch(() => state.maintenance.codex.quota);
  if (quota) state.maintenance.codex.quota = quota;
  await runCommand("/usr/bin/osascript", ["-e", 'tell application "Codex" to quit'], { timeout: 12000, allowFailure: true });
  await sleep(1800);
  const running = await isCodexDesktopAppRunning();
  return {
    ok: !running,
    summary: running ? "Codex desktop quit pending" : "Codex desktop quit",
    reply: !running
      ? quota
        ? `Codex 已按应用退出。\n\n${formatCodexQuotaDetail("退出前额度快照：", quota)}`
        : "Codex 已按应用退出。"
      : "我已经发了退出指令，但它现在看起来还没完全退掉。"
  };
}

function scheduleSystemSleep() {
  const child = spawn("/bin/zsh", ["-lc", "sleep 2; /usr/bin/osascript -e 'tell application \"System Events\" to sleep' >/dev/null 2>&1 || /usr/bin/pmset sleepnow >/dev/null 2>&1"], {
    detached: true,
    stdio: "ignore"
  });
  child.unref();
}

function runCommand(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: ["ignore", "pipe", "pipe"]
    });
    let output = "";
    let settled = false;
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      output += chunk;
    });
    child.stderr.on("data", (chunk) => {
      output += chunk;
    });
    const timeout = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill("SIGTERM");
      reject(new Error(`${command} timed out`));
    }, options.timeout || 15000);
    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      reject(error);
    });
    child.on("close", (status) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (status !== 0 && !options.allowFailure) {
        reject(new Error(`${command} exited ${status}: ${output.trim()}`));
        return;
      }
      resolve({ status, output });
    });
  });
}

async function captureDesktopScreenshot() {
  await mkdir(imessageScreenshotsDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const useOriginalForPhotos = imessageImageDelivery === "photos";
  const outputPath = join(imessageScreenshotsDir, `desktop-${stamp}.${useOriginalForPhotos ? "png" : "jpg"}`);
  if (useOriginalForPhotos) {
    await runCommand("/usr/sbin/screencapture", ["-x", "-t", "png", outputPath], { timeout: 15000 });
  } else {
    await runCommand("/usr/sbin/screencapture", ["-x", "-t", "jpg", outputPath], { timeout: 15000 });
    await runCommand("/usr/bin/sips", ["--resampleWidth", "1600", "-s", "format", "jpeg", "-s", "formatOptions", "80", outputPath, "--out", outputPath], { timeout: 15000, allowFailure: true });
    await runCommand("/usr/bin/xattr", ["-c", outputPath], { timeout: 5000, allowFailure: true });
  }
  await access(outputPath);
  return outputPath;
}

async function buildRemoteExecutionReply(event) {
  const id = crypto.randomUUID();
  const outputPath = join(codexTmpDir, `${id}.remote-execution.txt`);
  const memoryContext = formatRemoteExecutionMemoryContext();
  const unifiedMemoryContext = await unifiedMemory.formatForPrompt({ query: event.text, limit: 8 });
  const skillContext = await loadRemoteExecutionSkillContext();
  const effectiveModel = event.temporaryCodex?.model || state.remoteExecution.model;
  const effectiveReasoningEffort = event.temporaryCodex?.reasoningEffort || state.remoteExecution.reasoningEffort;
  const prompt = [
    // Deployment customization: this high-permission prompt is neutral. Add
    // relationship/profile wording through assistantProfilePath or skill paths.
    `你正在通过 iMessage 远程执行模式与${ownerLabel}对话。`,
    "这是一个完整 Codex CLI 通道：你可以检查本机文件、运行命令、修改项目，并在需要时控制桌面相关任务。",
    "用中文回复。先给结论和关键动作，不要把长日志整段塞进 iMessage；长输出应整理成摘要，并写明本地文件路径。",
    "不要在结尾追加 AI 助手味很重的服务式结束语，例如“要是你想，我下次也可以……”“想的话我还能……”“如果需要我可以……”“要不要我再……”。",
    `对删除文件、改系统设置、杀服务、发送外部消息、移动大量文件、代理/VPN 之类高风险动作，要先说明风险并要求${ownerLabel}再次确认，不要直接执行。`,
    `如果${ownerLabel}说“给我看看”“截图给我看”“现在什么样”等跟进话，并且前文刚操作过 Finder、文件夹、App 或桌面状态，你应该主动打开相关窗口或切到相关 App，再用 screencapture 生成 PNG 截图。`,
    `如果需要把截图或图片给${ownerLabel}看，请把图片保存为本机绝对路径，并在最终回复单独包含一行：[[imessage_attachment:/absolute/path/to/image.png]]。Hub 会根据当前配置把图片导入 Photos/iCloud 照片或作为 iMessage 附件发送。不要把标记解释给${ownerLabel}看。`,
    `你可以自然称呼对方为${ownerLabel}，自称用“我”。部署者可在 profile 中覆盖具体语气和自定义风格。`,
    `当前远程执行模式模型：${effectiveModel}`,
    `当前智能等级：${effectiveReasoningEffort}`,
    "",
    skillContext,
    skillContext ? "" : null,
    unifiedMemoryContext,
    unifiedMemoryContext ? "" : null,
    memoryContext,
    memoryContext ? "" : null,
    event.imagePaths?.length ? `收到的图片数量：${event.imagePaths.length}` : null,
    event.imagePaths?.length ? "请结合图片内容处理。如果图片看不清，就如实说明。" : null,
    event.imagePaths?.length ? "" : null,
    `${ownerLabel}刚刚在远程执行模式里说：`,
    event.text,
    "",
    "请执行需要的工作，并输出适合 iMessage 阅读的最终回复。"
  ].filter((part) => part != null).join("\n");

  await ensureCodexReplyWorkspace();
  state.remoteExecution.busy = true;
  try {
    const args = [
      "exec",
      "--ephemeral",
      "--skip-git-repo-check",
      "-s",
      "danger-full-access",
      "-m",
      effectiveModel,
      "-c",
      `model_reasoning_effort="${effectiveReasoningEffort}"`,
      "-C",
      projectDir,
      "-o",
      outputPath,
      ...((event.imagePaths || []).flatMap((imagePath) => ["--image", imagePath])),
      "-"
    ];
    await runCodexCli(args, prompt, {
      cwd: projectDir,
      timeout: 10 * 60 * 1000,
      env: {
        ...process.env,
        CODEX_REMOTE_CONTACT_REMOTE_EXECUTION_MODE: "1"
      }, budgetPurpose: 'remote-execution'
    });
    const reply = cleanCodexReply(await readFile(outputPath, "utf8")) || "远程执行模式执行完了，但没有生成可读回复。";
    await rememberRemoteExecutionTurn(event.text, reply);
    await rememberUnifiedMemoryFromRemoteExecution(event.text, reply);
    return reply.slice(0, 1800);
  } finally {
    state.remoteExecution.busy = false;
  }
}

function formatRemoteExecutionMemoryContext() {
  const entries = Array.isArray(state.remoteExecution.memory.entries) ? state.remoteExecution.memory.entries : [];
  if (!entries.length) return "";
  const lines = entries.slice(-state.remoteExecution.memory.limit).map((entry) => {
    const speaker = entry.role === "assistant" ? assistantName : ownerLabel;
    return `${speaker}：${String(entry.text || "").trim()}`;
  }).filter((line) => !/：$/.test(line));
  if (!lines.length) return "";
  return [
    "以下是远程执行模式的独立滚动记忆，请自然参考，不要逐字复述：",
    ...lines
  ].join("\n");
}

async function rememberRemoteExecutionTurn(userText, reply) {
  const entries = Array.isArray(state.remoteExecution.memory.entries) ? state.remoteExecution.memory.entries : [];
  const now = new Date().toISOString();
  entries.push(
    {
      role: "user",
      text: String(userText || "").trim().slice(0, 4000),
      at: now
    },
    {
      role: "assistant",
      text: String(reply || "").trim().slice(0, 4000),
      at: now
    }
  );
  state.remoteExecution.memory.entries = entries.slice(-state.remoteExecution.memory.limit);
  await saveRemoteExecutionMemory();
}

async function rememberUnifiedMemoryFromRemoteExecution(userText, reply) {
  const text = String(userText || "").trim();
  const result = String(reply || "").trim();
  if (!text || !result) return;
  const projectLike = /(实现|修改|修复|文件|代码|脚本|运行|测试|完成|打开|删除|创建|项目|部署|readme|截图)/i.test(`${text} ${result}`);
  if (!projectLike) return;
  await unifiedMemory.write({
    type: "projectNote",
    source: "remoteExecution",
    channel: "imessage",
    originDevice: "mobile_or_messages",
    executionDevice: "desktop",
    mode: "remoteExecution",
    topic: text.slice(0, 60),
    summary: `远程执行模式处理：${text.slice(0, 220)}；结果：${result.slice(0, 420)}`,
    sourceTextHint: text,
    confidence: 0.78,
    zone: "base"
  });
}

async function loadRemoteExecutionSkillContext() {
  const skill = state.remoteExecution.skill;
  if (!skill || skill === "none") return "";
  const path = getRemoteExecutionSkillRegistry()[skill];
  if (!path) return "";
  try {
    const body = await readFile(path, "utf8");
    return [
      `以下是远程执行模式当前启用的 skill：${skill}`,
      body.slice(0, 16000)
    ].join("\n");
  } catch (error) {
    return `当前设置的 skill ${skill} 读取失败：${error.message}`;
  }
}

async function buildIMessagePrivateReply(event, unifiedMemoryContext = "", options = {}) {
  const id = crypto.randomUUID();
  const outputPath = join(codexTmpDir, `${id}.imessage.txt`);
  const memoryContext = unifiedMemoryContext
    ? ""
    : formatUnifiedFlaskPrompt({
        entries: collectIMessageFlaskEntries(event.handle),
        unifiedPrompt: "",
        recallRoute: options.recallRoute
      });
  const effectiveModel = event.temporaryCodex?.model || state.ai.imessageModel;
  const effectiveReasoningEffort = event.temporaryCodex?.reasoningEffort || state.ai.imessageReasoningEffort;
  const prompt = [
    await buildIMessageInstructions(),
    "",
    unifiedMemoryContext,
    unifiedMemoryContext ? "" : null,
    memoryContext,
    memoryContext ? "" : null,
    event.imagePaths?.length ? `收到的图片数量：${event.imagePaths.length}` : null,
    event.imagePaths?.length ? "请结合图片内容回答。如果图片看不清，就如实说明。" : null,
    event.imagePaths?.length ? "" : null,
    "收到的 iMessage 私聊：",
    event.text,
    "",
    "请直接给出要通过 iMessage 发回去的最终回复。"
  ].filter((part) => part != null).join("\n");

  await ensureCodexReplyWorkspace();
  const args = [
    "exec",
    "--ephemeral",
    "--ignore-user-config",
    "--skip-git-repo-check",
    "--ignore-rules",
    "-s",
    "read-only",
    "-m",
    effectiveModel,
    "-c",
    `model_reasoning_effort="${effectiveReasoningEffort}"`,
    "-C",
    codexWorkspaceDir,
    "-o",
    outputPath,
    ...((event.imagePaths || []).flatMap((imagePath) => ["--image", imagePath])),
    "-"
  ];
  await runCodexCli(args, prompt, {
    cwd: codexWorkspaceDir,
    timeout: 90000,
    env: {
      ...process.env,
      CODEX_REMOTE_CONTACT_IMESSAGE_MODE: "1"
    }, budgetPurpose: 'imessage-chat'
  });
  const reply = cleanCodexReply(await readFile(outputPath, "utf8"));
  return (reply || "我在。").slice(0, 1200);
}

function getIMessageMemoryKey(handle) {
  return String(handle || "default").trim() || "default";
}

function collectIMessageFlaskEntries(handle) {
  const key = getIMessageMemoryKey(handle);
  const entries = Array.isArray(state.imessage.memory.entries[key]) ? state.imessage.memory.entries[key] : [];
  return entries
    .map((entry) => ({
      source: "conversation",
      role: entry.role,
      text: String(entry.text || "").replace(/\s+/g, " ").trim(),
      at: entry.at,
      timestamp: entry.at
    }))
    .filter((entry) => entry.text);
}

function formatIMessageMemoryContext(handle, options = {}) {
  const normalized = collectIMessageFlaskEntries(handle);
  if (!normalized.length) return "";

  const base = normalized.slice(-6);
  const body = normalized.slice(-18, -6);
  const neck = normalized.slice(0, -18);
  const formatLine = (entry) => {
    const speaker = entry.role === "assistant" ? assistantName : ownerLabel;
    const time = entry.at ? ` @${entry.at}` : "";
    return `${speaker}${time}：${entry.text.slice(0, 420)}`;
  };
  const bodyLines = compactIMessageFlaskEntries(body, 8, 180, formatLine);
  const neckLines = compactIMessageFlaskEntries(neck, 6, 120, formatLine);
  const priorityNote = options.desktopContextActive
    ? "当前存在更新的连续上下文；旧对话只用于语气、人物关系和背景。如果与更新片段冲突，以更新片段为准。"
    : "时效性优先：base 比 body 重要，body 比 neck 重要；旧内容只作背景，不要覆盖最新消息。";
  return [
    `以下是你和${ownerLabel}的统一锥形瓶上下文，请自然参考，不要逐字复述：`,
    priorityNote,
    "base / 最新手机侧原文：",
    ...base.map(formatLine),
    bodyLines.length ? "body / 较早手机侧摘要：" : "",
    ...bodyLines,
    neckLines.length ? "neck / 更早手机侧线索：" : "",
    ...neckLines
  ].filter(Boolean).join("\n");
}

function compactIMessageFlaskEntries(entries, limit, maxLength, formatLine) {
  if (!Array.isArray(entries) || !entries.length) return [];
  return entries
    .slice(-limit)
    .map((entry) => formatLine(entry).slice(0, maxLength))
    .filter(Boolean);
}

async function rememberIMessageTurn(event, reply) {
  const key = getIMessageMemoryKey(event.handle);
  const entries = Array.isArray(state.imessage.memory.entries[key]) ? state.imessage.memory.entries[key] : [];
  const now = new Date().toISOString();
  entries.push(
    {
      role: "user",
      text: String(event.text || "").trim().slice(0, 2000),
      at: now
    },
    {
      role: "assistant",
      text: String(reply || "").trim().slice(0, 2000),
      at: now
    }
  );
  state.imessage.memory.entries[key] = entries.slice(-state.imessage.memory.perHandleLimit);
  await saveIMessageMemory();
}

async function prepareUnifiedMemoryForIMessage(event) {
  const decision = await judgeUnifiedMemoryForIMessage(event);
  let recallRoute = await judgeUnifiedMemoryRecallRouteForIMessage(event, decision);
  if (!["read", "both"].includes(decision.action) && !recallRoute.needsRecall) {
    recallRoute = await chooseFreshCrossDeviceRecallRoute(event, recallRoute);
  }
  const query = recallRoute.query || decision.query || decision.topic || event.text;
  const unifiedPrompt = await unifiedMemory.formatForPrompt({
    query,
    limit: 8
  });
  const entries = [
    ...collectIMessageFlaskEntries(event.handle),
    ...await collectDesktopFlaskEntriesForIMessage(event, query, recallRoute)
  ];
  const promptContext = formatUnifiedFlaskPrompt({
    entries,
    unifiedPrompt,
    recallRoute
  });
  return {
    decision: recallRoute.needsRecall && decision.action === "none" ? { ...decision, action: "read", query } : decision,
    recallRoute,
    promptContext
  };
}

async function collectDesktopFlaskEntriesForIMessage(event, query, recallRoute = {}) {
  try {
    const latest = await searchRecentCodexContext({
      query: query || event.text,
      mode: recallRoute.source === "desktop_topic" ? "topic" : "latest",
      limit: 18,
      maxFiles: 24
    });
    let snippets = latest;
    const needsTopicBackfill = shouldBackfillTopicByStructure(event?.text, latest);
    if (needsTopicBackfill) {
      const topicQuery = inferDesktopTopicQuery(latest) || query || event.text;
      const topic = await searchRecentCodexContext({
        query: topicQuery,
        mode: "topic",
        limit: 18,
        maxFiles: 24
      });
      const completed = topic.filter((snippet) => isCompletedSnippet(snippet));
      snippets = completed.length ? [...latest, ...completed, ...topic] : latest;
    }
    return dedupeFlaskEntries(snippets.map((snippet) => ({
      source: "conversation",
      role: snippet.role,
      phase: snippet.phase,
      completed: snippet.completed,
      pinned: needsTopicBackfill && isCompletedSnippet(snippet),
      text: String(snippet.text || "").replace(/\s+/g, " ").trim(),
      at: snippet.timestamp,
      timestamp: snippet.timestamp,
      score: snippet.score
    })).filter((entry) => entry.text));
  } catch {
    return [];
  }
}

function shouldBackfillTopicByStructure(text, snippets = []) {
  const signal = textInformationSignal(text);
  if (signal.concreteAnchors >= 2) return false;
  if (signal.units <= 6) return true;
  const latestHasOnlyNonCompletedAssistant = snippets.some((snippet) => snippet.role === "assistant")
    && !snippets.some((snippet) => isCompletedSnippet(snippet));
  return signal.units <= 12 && latestHasOnlyNonCompletedAssistant;
}

function inferDesktopTopicQuery(snippets = []) {
  const answer = [...snippets].reverse().find((snippet) => isCompletedSnippet(snippet));
  if (answer?.text) return answer.text.slice(0, 180);
  const user = [...snippets].reverse().find((snippet) => (
    snippet.role === "user"
    && !isLowValueTopicText(snippet.text)
    && textInformationSignal(snippet.text).units > 6
  ));
  return user?.text?.slice(0, 120) || "";
}

function isCompletedSnippet(snippet) {
  return snippet?.completed === true || ["final_answer", "task_complete"].includes(String(snippet?.phase || ""));
}

function textInformationSignal(text) {
  const raw = String(text || "").trim();
  const cjkRuns = raw.match(/[\u4e00-\u9fff]{2,}/g) || [];
  const asciiRuns = raw.match(/[a-z0-9_.-]{3,}/gi) || [];
  const concreteAnchors = asciiRuns.length + cjkRuns.filter((run) => run.length >= 3).length;
  return {
    units: [...raw.matchAll(/[\u4e00-\u9fff]|[a-z0-9_.-]+/gi)].length,
    concreteAnchors
  };
}

function isLowValueTopicText(text) {
  return /(# Files mentioned by the user|\/(?:Users|home|var|tmp)\/|Library\/Containers|Data\/Library|\.png|\.jpe?g|截图|image)/i.test(String(text || ""));
}

function formatUnifiedFlaskPrompt({ entries = [], unifiedPrompt = "", recallRoute = null } = {}) {
  const normalized = entries
    .filter((entry) => entry?.text)
    .sort((a, b) => Date.parse(a.timestamp || a.at || "") - Date.parse(b.timestamp || b.at || ""));
  const deduped = dedupeFlaskEntries(normalized);
  const pinned = deduped.filter((entry) => entry.pinned).slice(-4);
  const base = dedupeFlaskEntries([...deduped.slice(-8), ...pinned])
    .sort((a, b) => Date.parse(a.timestamp || a.at || "") - Date.parse(b.timestamp || b.at || ""));
  const baseKeys = new Set(base.map((entry) => `${entry.role}:${entry.text}`));
  const rest = deduped.filter((entry) => !baseKeys.has(`${entry.role}:${entry.text}`));
  const body = rest.slice(-16);
  const neck = rest.slice(0, -16);
  const line = (entry, maxLength) => {
    const speaker = entry.role === "assistant"
      ? assistantName
      : entry.role === "tool"
        ? "执行结果"
        : entry.role === "event"
          ? "事件"
          : ownerLabel;
    const time = entry.timestamp || entry.at ? ` @${entry.timestamp || entry.at}` : "";
    const marker = entry.completed ? " [完成态]" : "";
    return `${speaker}${time}${marker}：${entry.text.slice(0, maxLength)}`;
  };
  const parts = [
    "以下是统一记忆锥形瓶。所有来源已融合为一条连续上下文，不要按设备割裂理解。",
    "时效性第一：base 是最新事实；body 是较早摘要；neck 和长期记忆只作背景。所有事件都会先进入溶液，再按时间和信息密度压缩。若内容冲突，以更新、更贴近当前问题的 base 为准。只有带明确时间点的完成态片段才能当作已完成结果；没看到完成态就说还没看到结果，不要脑补。",
    recallRoute?.reason ? `当前上下文路由：${recallRoute.reason}` : "",
    recallRoute?.comparedAt ? `新鲜度比较：latestA=${recallRoute.comparedAt.mobile || "none"} latestB=${recallRoute.comparedAt.desktop || "none"}` : "",
    base.length ? "base / 最新连续上下文：" : "",
    ...base.map((entry) => line(entry, 520)),
    body.length ? "body / 较早连续摘要：" : "",
    ...body.slice(-8).map((entry) => line(entry, 200)),
    neck.length ? "neck / 更早背景线索：" : "",
    ...neck.slice(-6).map((entry) => line(entry, 120)),
    unifiedPrompt ? `长期统一记忆：\n${unifiedPrompt}` : ""
  ];
  return parts.filter(Boolean).join("\n");
}

function dedupeFlaskEntries(entries) {
  const seen = new Set();
  const output = [];
  for (const entry of entries) {
    const key = `${entry.role}:${entry.text}`;
    if (seen.has(key)) continue;
    seen.add(key);
    output.push(entry);
  }
  return output;
}

async function buildRecentCodexContextForIMessage(event, query, unifiedPrompt, recallRoute = {}) {
  if (["mobile_context", "unified"].includes(recallRoute.source)) return "";
  const text = String(event.text || "");
  const shouldRecallDesktop = recallRoute.source?.startsWith?.("desktop")
    || /(电脑上|电脑这边|这边|cli|codex|client|webui|通讯中枢|客户端|更新|同步|刚刚|刚才|前两天|上次|之前|还记得|记不记得|接着|继续|做到哪|进度)/i.test(text);
  const unifiedLooksThin = !unifiedPrompt || unifiedPrompt.length < 260;
  if (!shouldRecallDesktop && !unifiedLooksThin) return "";
  try {
    const snippets = await searchRecentCodexContext({
      query,
      mode: recallRoute.source === "desktop_recent" ? "latest" : "topic",
      limit: 8,
      maxFiles: 12
    });
    return formatRecentContextPrompt(snippets);
  } catch {
    return "";
  }
}

async function judgeUnifiedMemoryRecallRouteForIMessage(event, decision) {
  const text = String(event.text || "").trim();
  let ruleRoute = routeUnifiedMemoryRecallByRules(text, decision, event);
  if (ruleRoute.reason === "generic_recent_work") {
    ruleRoute = await chooseGenericRecentRecallRoute(event, ruleRoute);
  }
  if (ruleRoute.source === "desktop_recent" && ruleRoute.confidence >= 0.82) return ruleRoute;
  if (!shouldRunRecallRouteModel(text, ruleRoute, decision)) return ruleRoute;
  try {
    const raw = await runUnifiedMemoryRecallRouteModel(text);
    const modelRoute = parseUnifiedMemoryRecallRoute(raw);
    if (!modelRoute.needsRecall) return ruleRoute.needsRecall ? ruleRoute : modelRoute;
    return modelRoute.confidence >= ruleRoute.confidence ? modelRoute : ruleRoute;
  } catch {
    return ruleRoute;
  }
}

async function chooseGenericRecentRecallRoute(event, fallbackRoute) {
  const mobile = getLatestIMessageTurnMeta(event?.handle);
  const desktop = await getLatestDesktopContextSnippet(event?.text || fallbackRoute.query);

  const mobileTime = Date.parse(mobile?.at || "");
  const desktopTime = Date.parse(desktop?.timestamp || "");
  if (Number.isFinite(mobileTime) && (!Number.isFinite(desktopTime) || mobileTime > desktopTime)) {
    return {
      needsRecall: true,
      source: "mobile_context",
      query: event?.text || fallbackRoute.query,
      confidence: 0.86,
      reason: "generic_recent_work_mobile_newer",
      comparedAt: { mobile: mobile?.at, desktop: desktop?.timestamp || null }
    };
  }

  return {
    ...fallbackRoute,
    source: "desktop_recent",
    confidence: Math.max(fallbackRoute.confidence || 0, 0.86),
    reason: "generic_recent_work_desktop_newer",
    comparedAt: { mobile: mobile?.at || null, desktop: desktop?.timestamp || null }
  };
}

async function chooseFreshCrossDeviceRecallRoute(event, fallbackRoute = {}) {
  const mobile = getLatestIMessageTurnMeta(event?.handle);
  const desktop = await getLatestDesktopContextSnippet(event?.text || fallbackRoute.query);
  const mobileTime = Date.parse(mobile?.at || "");
  const desktopTime = Date.parse(desktop?.timestamp || "");
  const freshWindowMs = 15 * 60 * 1000;
  const desktopIsFresh = Number.isFinite(desktopTime) && Date.now() - desktopTime <= freshWindowMs;
  const desktopBeatsMobile = desktopIsFresh && (!Number.isFinite(mobileTime) || desktopTime > mobileTime);
  if (!desktopBeatsMobile) {
    return {
      ...fallbackRoute,
      needsRecall: false,
      source: fallbackRoute.source || "none",
      query: fallbackRoute.query || "",
      confidence: fallbackRoute.confidence || 0.35,
      reason: fallbackRoute.reason || "no_fresh_cross_device_context",
      comparedAt: { mobile: mobile?.at || null, desktop: desktop?.timestamp || null }
    };
  }
  return {
    needsRecall: true,
    source: "desktop_recent",
    query: event?.text || fallbackRoute.query || "",
    confidence: 0.72,
    reason: "fresh_desktop_without_keyword",
    comparedAt: { mobile: mobile?.at || null, desktop: desktop?.timestamp || null }
  };
}

async function getLatestDesktopContextSnippet(query) {
  try {
    const snippets = await searchRecentCodexContext({
      query,
      mode: "latest",
      limit: 1,
      maxFiles: 12
    });
    return snippets[0] || null;
  } catch {
    return null;
  }
}

function routeUnifiedMemoryRecallByRules(text, decision = {}, event = null) {
  const normalized = String(text || "").replace(/\s+/g, "").toLowerCase();
  const previousUserText = getPreviousIMessageUserText(event?.handle);
  const previousNormalized = previousUserText.replace(/\s+/g, "").toLowerCase();
  const asksAboutPreviousQuestion = /(上面|上一条|刚才那个|刚刚那个|这个问题|那个问题|我发的|我问的|自己想出来|我自己想|谁想的|谁提的|谁建议的)/i.test(normalized);
  const previousLooksDesktopRecall = /(电脑上|电脑这边|桌面上|cli|codex|本机|这边|刚刚|刚才|统一记忆|复读|清理|修复|测试)/i.test(previousNormalized);
  const hasConcreteClientTopic = /(client|webui|通讯中枢|客户端|bundle|resources?|资源|启动器|localhost:3789)/i.test(normalized);
  const hasDesktop = /(电脑上|电脑这边|桌面上|cli|codex|本机|这边)/i.test(normalized);
  const hasRecent = /(刚刚|刚才|刚才那会|刚那会|刚在|刚问|刚说|刚发|刚做|刚弄|刚改|刚更新|刚修)/i.test(normalized);
  const hasGenericWorkRecall = /(做了什么|做过什么|干了什么|弄了什么|搞了什么|改了什么|更新了什么|处理了什么|修了什么|做到哪|做完没|弄好没|搞好没)/i.test(normalized);
  const hasMobileAnchor = /(手机上|手机端|imessage|短信里|消息里|这条消息|刚才这句|刚刚这句)/i.test(normalized);
  const hasPastTopic = /(前两天|昨天|上次|之前|做到哪|整理到哪|进度|还记得|记不记得|接着|继续)/i.test(normalized);
  if (asksAboutPreviousQuestion && previousLooksDesktopRecall) {
    return {
      needsRecall: true,
      source: "desktop_recent",
      query: `${previousUserText}\n${text}`,
      confidence: 0.88,
      reason: "previous_imessage_desktop_question"
    };
  }
  if (hasConcreteClientTopic) {
    return {
      needsRecall: true,
      source: "desktop_topic",
      query: "通讯 Client WebUI client.html client.js client.css bundle Resources 同步 更新",
      confidence: 0.9,
      reason: "client_topic"
    };
  }
  if (hasRecent && hasDesktop) {
    return {
      needsRecall: true,
      source: "desktop_recent",
      query: text,
      confidence: 0.82,
      reason: "recent_desktop"
    };
  }
  if (hasRecent && hasGenericWorkRecall && !hasMobileAnchor) {
    return {
      needsRecall: true,
      source: "desktop_recent",
      query: text,
      confidence: 0.84,
      reason: "generic_recent_work"
    };
  }
  if (hasDesktop || hasPastTopic || ["read", "both"].includes(decision.action)) {
    return {
      needsRecall: true,
      source: hasRecent ? "desktop_recent" : "desktop_topic",
      query: decision.query || decision.topic || text,
      confidence: 0.68,
      reason: "weak_recall"
    };
  }
  return { needsRecall: false, source: "none", query: "", confidence: 0.35, reason: "none" };
}

function getPreviousIMessageUserText(handle) {
  const key = getIMessageMemoryKey(handle);
  const entries = Array.isArray(state.imessage.memory.entries[key]) ? state.imessage.memory.entries[key] : [];
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    if (entry?.role === "user" && String(entry.text || "").trim()) {
      return String(entry.text || "").trim();
    }
  }
  return "";
}

function getLatestIMessageTurnMeta(handle) {
  const key = getIMessageMemoryKey(handle);
  const entries = Array.isArray(state.imessage.memory.entries[key]) ? state.imessage.memory.entries[key] : [];
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    if (String(entry?.text || "").trim() && entry?.at) {
      return {
        role: entry.role,
        text: String(entry.text || "").trim(),
        at: entry.at
      };
    }
  }
  return null;
}

function shouldRunRecallRouteModel(text, ruleRoute, decision = {}) {
  const normalized = String(text || "").replace(/\s+/g, "");
  if (normalized.length < 5) return false;
  if (ruleRoute.confidence >= 0.9) return false;
  if (/(那个|这个|这边|那边|刚刚|刚才|之前|上次|前两天|更新|同步|做到哪|进度|还记得|接着|继续|client|webui|通讯)/i.test(normalized)) return true;
  return ["read", "both"].includes(decision.action) && ruleRoute.confidence < 0.82;
}

async function runUnifiedMemoryRecallRouteModel(text) {
  const id = crypto.randomUUID();
  const outputPath = join(codexTmpDir, `${id}.unified-memory-recall-route.txt`);
  await ensureCodexReplyWorkspace();
  const prompt = [
    "你是 iMessage 跨端记忆回看路由判断器，只输出 JSON。",
    "判断用户这句话是否需要读取跨端上下文，以及应该查哪里。",
    "source 只能是：desktop_recent、desktop_topic、mobile_context、unified、none。",
    "规则：",
    "- 问“刚刚/刚才 + 电脑/这边”且没有明确主题，通常是 desktop_recent。",
    "- 有明确主题词如 client、WebUI、通讯中枢、codexremotecontact、小火箭，通常是 desktop_topic，并生成对应检索词。",
    "- 问手机上/iMessage 里刚说的，选 mobile_context。",
    "- 只是普通闲聊，不需要回看，选 none。",
    "- query 要短，包含检索关键词，不要写完整回复。",
    "输出格式：",
    "{\"needsRecall\":true,\"source\":\"desktop_topic\",\"query\":\"client WebUI bundle 资源同步\",\"confidence\":0.8}",
    "",
    "用户消息：",
    text
  ].join("\n");
  const args = [
    "exec",
    "--ephemeral",
    "--ignore-user-config",
    "--skip-git-repo-check",
    "--ignore-rules",
    "-s",
    "read-only",
    "-m",
    codexModel,
    "-c",
    `model_reasoning_effort="${codexReasoningEffort}"`,
    "-C",
    codexWorkspaceDir,
    "-o",
    outputPath,
    "-"
  ];
  await runCodexCli(args, prompt, {
    cwd: codexWorkspaceDir,
    timeout: 60000,
    env: {
      ...process.env,
      CODEX_REMOTE_CONTACT_UNIFIED_MEMORY_RECALL_ROUTE: "1"
    }, budgetPurpose: 'memory-recall'
  });
  return readFile(outputPath, "utf8");
}

function parseUnifiedMemoryRecallRoute(raw) {
  try {
    const parsed = JSON.parse(String(raw || "").match(/\{[\s\S]*\}/)?.[0] || raw);
    const source = ["desktop_recent", "desktop_topic", "mobile_context", "unified", "none"].includes(parsed.source) ? parsed.source : "none";
    return {
      needsRecall: Boolean(parsed.needsRecall) && source !== "none",
      source,
      query: String(parsed.query || "").trim().slice(0, 160),
      confidence: Math.max(0, Math.min(1, Number(parsed.confidence || 0.5))),
      reason: "model"
    };
  } catch {
    return { needsRecall: false, source: "none", query: "", confidence: 0.35, reason: "parse_failed" };
  }
}

async function judgeUnifiedMemoryForIMessage(event) {
  const ruleDecision = judgeUnifiedMemoryByRules({
    text: event.text,
    source: "imessage",
    channel: "imessage",
    originDevice: "mobile_or_messages"
  });
  if (ruleDecision.action !== "none" && ruleDecision.confidence >= 0.78) return ruleDecision;
  if (String(event.text || "").trim().length < 8) return ruleDecision;
  try {
    const raw = await runUnifiedMemoryJudgeModel(event.text);
    const modelDecision = parseUnifiedMemoryJudge(raw);
    if (modelDecision.action === "none") return ruleDecision.action === "none" ? modelDecision : ruleDecision;
    return modelDecision.confidence >= ruleDecision.confidence ? modelDecision : ruleDecision;
  } catch {
    return ruleDecision;
  }
}

async function runUnifiedMemoryJudgeModel(text) {
  const id = crypto.randomUUID();
  const outputPath = join(codexTmpDir, `${id}.unified-memory-judge.txt`);
  await ensureCodexReplyWorkspace();
  const args = [
    "exec",
    "--ephemeral",
    "--ignore-user-config",
    "--skip-git-repo-check",
    "--ignore-rules",
    "-s",
    "read-only",
    "-m",
    codexModel,
    "-c",
    `model_reasoning_effort="${codexReasoningEffort}"`,
    "-C",
    codexWorkspaceDir,
    "-o",
    outputPath,
    "-"
  ];
  await runCodexCli(args, buildUnifiedMemoryJudgePrompt({ source: "imessage", text }), {
    cwd: codexWorkspaceDir,
    timeout: 60000,
    env: {
      ...process.env,
      CODEX_REMOTE_CONTACT_UNIFIED_MEMORY_JUDGE: "1"
    }, budgetPurpose: 'memory-judge'
  });
  return readFile(outputPath, "utf8");
}

async function applyUnifiedMemoryDecision(event, reply) {
  const decision = event.unifiedMemoryDecision;
  const recallRoute = event.unifiedMemoryRecallRoute || {};
  if (!decision) return;
  if (decision.action === "read" && state.unifiedMemory.autoWriteOnIMessageRecall) {
    if (!shouldAutoWriteIMessageRecall(event, reply, recallRoute)) return;
    await unifiedMemory.write({
      type: "handoff",
      source: "imessage",
      channel: "imessage",
      originDevice: "mobile_or_messages",
      executionDevice: "desktop",
      mode: "imessage_recall",
      topic: decision.topic || recallRoute.query || inferIMessageRecallTopic(event.text),
      summary: buildIMessageRecallHandoffSummary(event.text, reply, recallRoute),
      sourceTextHint: event.text,
      confidence: Math.max(0.72, Number(decision.confidence || 0.72)),
      zone: "base"
    });
    return;
  }
  if (!["write", "both"].includes(decision.action)) return;
  if (!decision.summary) return;
  await unifiedMemory.write({
    type: decision.memoryType,
    source: "imessage",
    channel: "imessage",
    originDevice: "mobile_or_messages",
    executionDevice: "desktop",
    mode: "imessage_private",
    topic: decision.topic,
    summary: decision.summary,
    nextActions: decision.nextActions,
    sourceTextHint: event.text,
    confidence: decision.confidence,
    zone: "base"
  });
  if (/实质工作|实现|修复|完成|做到|进度|项目/.test(`${decision.summary} ${reply}`)) {
    await unifiedMemory.write({
      type: "handoff",
      source: "imessage",
      channel: "imessage",
      originDevice: "mobile_or_messages",
      executionDevice: "desktop",
      mode: "imessage_private",
      topic: decision.topic || "iMessage 交接",
      summary: decision.summary,
      nextActions: decision.nextActions,
      sourceTextHint: event.text,
      confidence: Math.max(0.72, Number(decision.confidence || 0.72)),
      zone: "base"
    });
  }
}

function shouldAutoWriteIMessageRecall(event, reply, recallRoute = {}) {
  const text = String(event?.text || "").replace(/\s+/g, "");
  const result = String(reply || "");
  const genericRecent = recallRoute.source === "desktop_recent"
    || /(刚刚|刚才|刚才那会|刚那会).*(电脑上|电脑这边|这边|本机|codex|cli).*(什么|没|了吗|没有|做|弄|改|更新|同步|进度|结果)/i.test(text);
  if (genericRecent) return false;
  if (/(傻傻|只抓一个关键词|错误交接|带偏|这类问法|刚刚做了什么|改了什么|更新了什么|完成了什么)/.test(result)) return false;
  return recallRoute.source === "desktop_topic" || recallRoute.source === "mobile_context" || recallRoute.source === "unified";
}

function inferIMessageRecallTopic(text) {
  return String(text || "")
    .replace(/^(还记得|记不记得|刚刚|刚才|电脑上|手机上|接着|继续)/g, "")
    .trim()
    .slice(0, 60) || "iMessage 跨端回看";
}

function buildIMessageRecallHandoffSummary(userText, reply, recallRoute = {}) {
  const question = String(userText || "").trim().slice(0, 220);
  const route = recallRoute.source ? `，回看来源 ${recallRoute.source}` : "";
  const query = recallRoute.query ? `，检索词：${String(recallRoute.query).trim().slice(0, 120)}` : "";
  return `iMessage 触发跨端主题回看${route}${query}。用户问：“${question}”。`;
}

async function buildIMessageInstructions() {
  const assistantSkillBrief = await loadAssistantSkillBrief();
  return [
    // Deployment customization: keep release iMessage replies neutral; add
    // character voice in assistantProfilePath.
    "你正在为可信 iMessage 私聊生成一条回复。",
    "只输出最终要发送的中文文本，不要解释，不要写标题，不要使用 Markdown。",
    `你是 ${assistantName}。自称用“我”。对方是${ownerLabel}，可以自然使用这个称呼。`,
    "私聊可以更自然一点，但仍然保持简短，通常 1 到 4 句。",
    "如果提供了长期滚动上下文，请把它当作私聊记忆使用：能承接前文，但不要主动复读记忆内容。",
    "不要在结尾追加 AI 助手味很重的服务式结束语，例如“想的话我还能……”“如果需要我可以……”“要不要我再……”。",
    "不要执行电脑操作；只有以 / 开头的 iMessage 指令由 Hub 执行。普通私聊只回应文本。",
    "可以有少量自然动作描写，但只使用通用日常动作；具体角色外观和关系感由部署者 profile 提供。",
    "",
    "以下是可选风格摘要：",
    assistantSkillBrief
  ].join("\n");
}

function sendIMessageReply(handle, text) {
  return new Promise((resolve, reject) => {
    rememberIMessageReply(text);
    const script = [
      "on run argv",
      "set targetHandle to item 1 of argv",
      "set replyText to item 2 of argv",
      "tell application \"Messages\"",
      "set targetService to 1st service whose service type = iMessage",
      "set targetBuddy to buddy targetHandle of targetService",
      "send replyText to targetBuddy",
      "end tell",
      "end run"
    ].join("\n");
    const child = spawn("/usr/bin/osascript", ["-e", script, handle, text], {
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve({ ok: true });
      else reject(new Error((stderr || stdout || `osascript exited ${code}`).trim()));
    });
  });
}

function sendIMessageAttachment(handle, filePath) {
  return new Promise((resolve, reject) => {
    prepareIMessageAttachment(filePath).then((preparedPath) => {
    const script = [
      "on run argv",
      "set targetHandle to item 1 of argv",
      "set attachmentPath to item 2 of argv",
      "set attachmentFile to POSIX file attachmentPath",
      "tell application \"Messages\"",
      "set targetService to 1st service whose service type = iMessage",
      "set targetBuddy to buddy targetHandle of targetService",
      "send attachmentFile to targetBuddy",
      "end tell",
      "end run"
    ].join("\n");
    const child = spawn("/usr/bin/osascript", ["-e", script, handle, preparedPath], {
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve({ ok: true });
      else reject(new Error((stderr || stdout || `osascript exited ${code}`).trim()));
    });
    }).catch(reject);
  });
}

async function prepareIMessageAttachment(filePath) {
  const sourcePath = String(filePath || "").trim();
  await access(sourcePath);
  const extension = extname(sourcePath).toLowerCase();
  if (![".png", ".jpg", ".jpeg"].includes(extension)) return sourcePath;

  await mkdir(imessageScreenshotsDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const outputPath = join(imessageScreenshotsDir, `attachment-${stamp}.jpg`);
  await runCommand("/usr/bin/sips", ["--resampleWidth", "1600", "-s", "format", "jpeg", "-s", "formatOptions", "80", sourcePath, "--out", outputPath], { timeout: 15000 });
  await runCommand("/usr/bin/xattr", ["-c", outputPath], { timeout: 5000, allowFailure: true });
  await access(outputPath);
  return outputPath;
}

async function importImageToPhotos(filePath) {
  const preparedPath = String(filePath || "").trim();
  await access(preparedPath);
  return new Promise((resolve, reject) => {
    const script = [
      "on run argv",
      "set imagePath to item 1 of argv",
      "set imageFile to POSIX file imagePath as alias",
      "tell application \"Photos\"",
      "import {imageFile} skip check duplicates yes",
      "end tell",
      "end run"
    ].join("\n");
    const child = spawn("/usr/bin/osascript", ["-e", script, preparedPath], {
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve({ ok: true, output: stdout.trim(), path: preparedPath });
      else reject(new Error((stderr || stdout || `osascript exited ${code}`).trim()));
    });
  });
}

function formatQuotedContext(event) {
  if (!event.replyContext) return "";
  const context = event.replyContext;
  const speaker = context.isSelf
    ? `${assistantName} 之前发出的消息`
    : getSenderLabel(context.senderId, context.senderName);
  const text = stripMentionText(context.text || "");
  const imageSummary = formatQqImageSummary(context.images || []);
  if (!text && !imageSummary) return "";
  const replyHint = context.isSelf
    ? (context.scopeVerified ? "这条消息引用了你在当前私聊发过的内容。"
      : "用户引用了你的消息；桥接未提供原接收对象，不能断言这是你对当前对象说过的话。")
    : "这条消息引用了下面这条上下文。";
  return [
    "被回复/引用的消息上下文：",
    replyHint,
    `${speaker}：${text || "（图片消息）"}`,
    imageSummary ? `引用消息图片：${imageSummary}` : null
  ].filter(Boolean).join("\n");
}

function runCodexCli(args, input, options) {
  return runtimeBudget.run({ purpose: options.budgetPurpose || 'runtime-cli' },
    () => measureModelCall(() => executeCodexCli(args, input, options)));
}
async function executeCodexCli(args, input, options) {
  const startedAt = Date.now();
  const previousQuota = state.maintenance.codex.quota;
  args = args.filter(arg => isMac || !['--ignore-user-config', '--ignore-rules'].includes(arg));
  if (!args.includes('--json')) args.splice(1, 0, '--json');
  const modelIndex = args.indexOf('-m');
  if (modelIndex !== -1 && args[modelIndex + 1] === 'default') args.splice(modelIndex, 2);
  // Apply to bot subprocesses only; preserve the user's desktop preferences/plugins.
  args.splice(1, 0, '-c', 'analytics.enabled=false');
  const invocation = codexCommand(resolveCodex(), args);
  const childEnv = { ...options.env };
  if (localConfig.codexProxy) {
    childEnv.HTTP_PROXY = localConfig.codexProxy;
    childEnv.HTTPS_PROXY = localConfig.codexProxy;
    childEnv.NO_PROXY = childEnv.NO_PROXY || 'localhost,127.0.0.1,::1';
  }
  try {
    if (localConfig.codexProxy) {
      try { await assertProxyReachable(localConfig.codexProxy); }
      catch (error) { error.safeForChat = true; throw error; }
    }
    let exited = false;
    const noteExit = () => { if (!exited) { exited = true; activeCliProcesses--; } };
    activeCliProcesses++;
    let result;
    try {
      result = await runCliProcess({ ...invocation, cwd: options.cwd, env: childEnv,
        input, timeout: options.timeout, earlyReply: Boolean(options.earlyReply), onExit: noteExit });
    } catch (error) { noteExit(); throw error; }
    state.maintenance.codex.lastOk = true;
    state.maintenance.codex.lastError = null;
    void refreshCodexQuotaSnapshotAfterRun({ startedAtMs: startedAt, previousQuota }).catch(() => null);
    return result;
  } catch (caught) {
    const reference = crypto.randomUUID();
    const logPath = join(projectDir, 'runtime', 'logs', `cli-error-${reference}.json`);
    try {
      await mkdir(join(projectDir, 'runtime', 'logs'), { recursive: true });
      await writeFile(logPath, JSON.stringify({ code: caught.code, at: new Date().toISOString(),
        stdout: caught.stdout || '', stderr: caught.stderr || caught.message }, null, 2));
    } catch { /* Raw failures remain local even if logging fails. */ }
    const message = `${caught.safeForChat ? caught.message : classifyCliFailure(caught.stdout || '', caught.stderr || `ERROR: ${caught.message}`)}（错误编号 ${reference.slice(0, 8)}）`;
    state.maintenance.codex.lastOk = false;
    state.maintenance.codex.lastError = message;
    const error = new Error(message); error.safeForChat = true;
    // Keep numeric usage through sanitization; diagnostics and prompts stay local.
    error.usage = caught.usage || null;
    throw error;
  } finally {
    state.maintenance.codex.lastRunAt = new Date().toISOString();
    state.maintenance.codex.lastDurationMs = Date.now() - startedAt;
  }
}

async function ensureCodexReplyWorkspace() {
  await mkdir(codexWorkspaceDir, { recursive: true });
  await mkdir(codexTmpDir, { recursive: true });
  if (await access(join(codexWorkspaceDir, 'AGENTS.md')).then(() => true).catch(() => false)) return;
  await writeFile(
    join(codexWorkspaceDir, "AGENTS.md"),
    [
      // Deployment customization: this generated AGENTS.md must stay generic.
      // Add a custom assistant profile via CODEX_REMOTE_CONTACT_ASSISTANT_PROFILE_PATH.
      `# ${assistantName} QQ Reply Workspace`,
      "",
      "你在这里专门为 QQ 私聊生成回复。",
      "只输出最终要发给对方的文本，自称用‘我’。",
      `需要自称名字时使用 ${assistantName}。`,
      ...(state.qq.enhancer.enabled ? buildQqReplyWorkspaceStyleInstructions() : []),
      "以当前提示提供的人格与私聊上下文为准；管理员说普通话时也自然聊天，只有明确的 / 指令属于管理操作。",
      "可以参考 Hub 提供的联网查询摘要，不编造没有读到的内容，也不虚构已经执行的操作。",
      "不复读昵称，不在结尾机械追加服务式邀约。",
      "不透露私人配置、后台路径、凭据或其他对象的私聊。",
      "涉及电脑或账号操作时遵循已授权范围；普通聊天不能替代操作授权。",
      "如果需要通过 QQ 发图，单独输出一行 [[qq_image:/absolute/path/to/image.png]]。",
      state.qq.enhancer.enabled ? "如果要发表情包，优先输出 [[qq_sticker:表情包名]]；表情包名必须来自提示里的本地表情包库。" : null,
      "不要写解释、分析、标题或 Markdown。"
    ].filter(Boolean).join("\n")
  );
}

async function sendOneBotPrivateReply(event, reply, { splitText = false } = {}) {
  if (!isPrivateMemoryEvent(event)) return { ok: false, reason: 'Private chat requires a valid participant' };
  const message = await buildOneBotPrivateReplyMessage(reply);
  return inReplyOrder(`private:${event.senderId}`, async () => {
    if (/^\s*\//.test(event.text || '')) {
      const commandDelayMs = 2000 + Math.floor(Math.random() * 4001);
      if (event.timings) event.timings.commandDelayMs = commandDelayMs;
      await sleep(commandDelayMs);
    }
    return sendTextThenSticker(message, async segments => {
      const result = await sendCurrentPrivateSegments(event, segments);
      const id = result.ok ? result.body?.data?.message_id : null;
      if (id != null) event.sentMessageIds = [...(event.sentMessageIds || []), String(id)].slice(-8);
      return result;
    }, { splitText });
  });
}

function isCurrentLifeReply(event) {
  if (!lifeContacts || /^\s*\//.test(event.text || '')) return true;
  return isLifeReplyEligible(event) && lifeContacts.isCurrent(event.lifeContactToken);
}

// Run inside the recipient's send queue, immediately before each transport
// invocation. A text reply and its optional sticker are separate boundaries.
function sendCurrentPrivateSegments(event, segments) {
  if (!isCurrentLifeReply(event)) return Promise.resolve({ ok: false, reason: 'contact-epoch-superseded' });
  const send = () => {
    // The coordinator may wait for an earlier state write. Recheck permissions
    // and a catch-up's availability after that wait as well as after send order.
    if (!isCurrentLifeReply(event)) return { ok: false, reason: 'contact-epoch-superseded' };
    if (lifeTimeline && !/^\s*\//.test(event.text || '')) {
      const available = lifeTimeline.availability({ scope: memoryScope(event) });
      if (event.lifeStatusActivityId) {
        if (!available.busy || available.activityId !== event.lifeStatusActivityId) return { ok: false, reason: 'life-status-expired' };
      } else if (available.busy || (lifeConversation && !lifeConversation.isReplyCurrent(event.lifeReplyTicket))) {
        return { ok: false, reason: 'life-choice-replaced' };
      }
    }
    event.lifeTransportStarted = true;
    return sendOneBotSegments('private', Number(event.senderId), segments);
  };
  return lifeContacts && !/^\s*\//.test(event.text || '')
    ? lifeContacts.sendIfCurrent(event.lifeContactToken, send)
    : send();
}

async function sendOneBotSegments(type, id, message) {
  if (type !== 'private') return { ok: false, reason: 'Private-only mode' };
  if (!/^[1-9]\d*$/.test(String(id))) return { ok: false, reason: 'Invalid private recipient' };
  const response = await oneBotFetch(`${oneBotApiBase}/send_private_msg`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ user_id: id, message })
  });
  const body = await response.json().catch(() => ({}));
  const ok = response.ok && (body.status == null || body.status === 'ok');
  if (ok && body.data?.message_id != null) {
    const key = String(body.data.message_id);
    privateDeliveryRecipients.delete(key);
    privateDeliveryRecipients.set(key, String(id));
    while (privateDeliveryRecipients.size > 5000) privateDeliveryRecipients.delete(privateDeliveryRecipients.keys().next().value);
  }
  return { ok, status: response.status, body };
}
async function buildOneBotPrivateReplyMessage(reply) {
  reply = ensureStickerLeadText(reply);
  const message = [];
  const imagePaths = await resolveQqReplyMedia(reply, { stickerDir: qqStickerDir });
  const text = stripQqImageAttachmentMarkers(reply);
  if (text) {
    message.push({
      type: "text",
      data: { text }
    });
  }
  for (const imagePath of imagePaths) {
    message.push(buildQqImageSegment(imagePath));
  }
  if (message.length === 0) {
    message.push({
      type: "text",
      data: { text: "这个表情包没找到，请先把素材放进表情包库。" }
    });
  }
  return message;
}

async function fetchOneBotMessage(messageId, selfId, privateSenderId) {
  if (!messageId) return null;
  const response = await oneBotFetch(`${oneBotApiBase}/get_msg`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ message_id: Number(messageId) })
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok || body.status !== "ok" || !body.data) {
    throw new Error(`Unable to fetch quoted QQ message ${messageId}`);
  }

  const data = body.data;
  const sourceSender = data.user_id ?? data.sender?.user_id;
  const senderId = sourceSender == null ? undefined : String(sourceSender);
  const isSelf = selfId != null && senderId === String(selfId);
  const targetId = data.target_id == null ? null : String(data.target_id);
  if (privateSenderId != null && (data.group_id != null
    || (data.message_type != null && data.message_type !== 'private')
    || ![String(privateSenderId), String(selfId)].includes(senderId)
    || (targetId != null && targetId !== String(isSelf ? privateSenderId : selfId)))) {
    throw Error('Quoted message is outside this private conversation');
  }
  if (isSelf && privateSenderId != null && targetId == null) {
    const deliveredTo = privateDeliveryRecipients.get(String(data.message_id ?? messageId));
    const confirmed = deliveredTo != null ? deliveredTo === String(privateSenderId)
      : await unifiedMemory.hasDeliveredMessage({ scope: `qq:private:${privateSenderId}`, messageId: String(data.message_id ?? messageId) });
    if (!confirmed) throw Error('Quoted bot message recipient cannot be verified');
  }
  const segments = Array.isArray(data.message) ? data.message : [];
  const forwardSegment = segments.find((segment) => segment?.type === "forward");
  const textFromSegments = segments
    .filter((segment) => segment?.type === "text")
    .map((segment) => segment.data?.text ?? "")
    .join("")
    .trim();
  const forwardContext = forwardSegment?.data?.id
    ? await fetchOneBotForwardContent(forwardSegment.data.id).catch(() => null)
    : null;
  const images = dedupeQqImages([
    ...extractOneBotImageInputs(data),
    ...((forwardContext?.images) || [])
  ]);
  return {
    messageId: String(data.message_id ?? messageId),
    senderId,
    senderName: data.sender?.card || data.sender?.nickname || senderId || "对方",
    text: forwardContext?.text
      ? `[合并转发]\n${forwardContext.text}`
      : (data.raw_message || textFromSegments),
    images,
    isSelf,
    scopeVerified: privateSenderId != null,
    raw: data
  };
}

async function fetchOneBotForwardContent(forwardId) {
  const response = await oneBotFetch(`${oneBotApiBase}/get_forward_msg`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ id: String(forwardId) })
  });
  const body = await response.json().catch(() => ({}));
  const messages = Array.isArray(body.data?.messages)
    ? body.data.messages
    : Array.isArray(body.data)
      ? body.data
      : [];
  if (!response.ok || body.status !== "ok" || messages.length === 0) {
    throw new Error(`Unable to fetch forward QQ message ${forwardId}`);
  }

  const lines = [];
  const images = [];
  for (const node of messages) {
    const senderName = node?.sender?.card || node?.sender?.nickname || node?.nickname || "对方";
    const segments = Array.isArray(node?.content)
      ? node.content
      : Array.isArray(node?.message)
        ? node.message
        : Array.isArray(node?.data?.content)
          ? node.data.content
          : [];
    const text = segments
      .filter((segment) => segment?.type === "text")
      .map((segment) => segment.data?.text ?? "")
      .join("")
      .trim();
    const nodeImages = extractOneBotImageInputs({ message: segments });
    if (text) lines.push(`${senderName}：${text}`);
    else if (nodeImages.length > 0) lines.push(`${senderName}：[图片]`);
    images.push(...nodeImages);
  }

  return {
    text: lines.join("\n").trim(),
    images: dedupeQqImages(images)
  };
}

function dedupeQqImages(images) {
  const seen = new Set();
  const output = [];
  for (const image of images || []) {
    const key = `${image.file || ""}|${image.url || ""}`;
    if (seen.has(key)) continue;
    seen.add(key);
    output.push(image);
  }
  return output;
}

async function attachReplyContext(event) {
  if (!event.replyMessageId) return event;
  try {
    const replyContext = await fetchOneBotMessage(event.replyMessageId, event.selfId, event.senderId);
    return {
      ...event,
      replyContext,
      isReplyToSelf: Boolean(replyContext?.isSelf)
    };
  } catch (error) {
    return {
      ...event,
      replyContextError: error.message,
      isReplyToSelf: false
    };
  }
}

function normalizeOneBotEvent(payload) {
  const segments = Array.isArray(payload.message) ? payload.message : [];
  const hasAudioSegment = segments.some((segment) => ["record", "voice", "audio"].includes(String(segment?.type || "").toLowerCase()));
  const textFromSegments = segments
    .filter((segment) => segment?.type === "text")
    .map((segment) => segment.data?.text ?? "")
    .join("")
    .trim();
  const hasAtSegment = segments.some((segment) => segment?.type === "at");
  const hasSelfAtSegment = segments.some((segment) => isSelfAtSegment(segment, payload.self_id));
  const atTargets = segments
    .filter((segment) => segment?.type === "at")
    .map((segment) => segment.data?.qq ?? segment.data?.id ?? segment.data?.uin)
    .filter((target) => target != null)
    .map(String);
  const replySegment = segments.find((segment) => segment?.type === "reply");
  const replyMessageId = replySegment?.data?.id || replySegment?.data?.message_id;
  const images = extractOneBotImageInputs(payload);

  return {
    type: "private_message",
    selfId: payload.self_id == null ? undefined : String(payload.self_id),
    senderId: payload.user_id == null ? undefined : String(payload.user_id),
    senderName: payload.sender?.card || payload.sender?.nickname || String(payload.user_id || "对方"),
    text: payload.raw_message || textFromSegments,
    images,
    hasAudioSegment,
    hasAtSegment,
    hasSelfAtSegment,
    atTargets,
    hasReplySegment: Boolean(replySegment),
    replyMessageId: replyMessageId == null ? undefined : String(replyMessageId),
    isReplyToSelf: false,
    raw: payload
  };
}

function isSelfAtSegment(segment, selfId) {
  if (segment?.type !== "at" || selfId == null) return false;
  const target = segment.data?.qq ?? segment.data?.id ?? segment.data?.uin;
  return target != null && String(target) === String(selfId);
}

function enrichQqEvent(event) {
  const senderId = event.senderId == null ? undefined : String(event.senderId);
  const isOwner = senderId ? state.qq.ownerUserIds.includes(senderId) : false;
  return {
    ...event,
    senderId,
    isOwner,
    senderLabel: getSenderLabel(senderId, event.senderName)
  };
}

function getEventDedupeKey(event) {
  const raw = event.raw || {};
  if (raw.message_id != null) return `message_id:${event.senderId}:${raw.message_id}`;
  return null;
}

function rememberEvent(key) {
  if (!key) return false;
  const now = Date.now();
  for (const [seenKey, seenAt] of seenOneBotMessageIds) {
    if (now - seenAt > seenMessageTtlMs) seenOneBotMessageIds.delete(seenKey);
  }
  if (seenOneBotMessageIds.has(key)) return true;
  seenOneBotMessageIds.set(key, now);
  return false;
}

async function handleApi(req, res) {
  if (req.method === 'GET' && req.url === '/api/platform') {
    return sendJson(res, 200, { platform: process.platform, imessage: isMac,
      worldEnabled: Boolean(world), lifeEnabled: Boolean(lifeTimeline), lifePlanningEnabled: Boolean(lifePlanner), qqPrivateOnly: localConfig.qqPrivateOnly === true,
      runtimeBudget: runtimeBudget.getStatus(),
      skills: Object.keys(installedSkills), chatSkill: resolveChatSkill(installedSkills, localConfig.chatSkill),
      remoteEnabled: privateTasks.enabled, remoteBusy: privateTasks.busy,
      workspace: localConfig.workspace, owners: state.qq.ownerUserIds,
      callback: 'http://127.0.0.1:' + (process.env.PORT || 3789) + '/api/onebot/event',
      callbackSecretConfigured: Boolean(oneBotSecret) });
  }
  if (req.method === "OPTIONS") {
    res.writeHead(204, corsHeaders());
    res.end();
    return true;
  }

  if (req.method === "GET" && req.url === "/api/state") {
    return sendJson(res, 200, buildPublicState());
  }

  if (req.method === "GET" && req.url === "/api/maintenance") {
    return sendJson(res, 200, await buildMaintenanceStatus());
  }

  if (req.method === "GET" && req.url === "/api/memory") {
    return sendJson(res, 200, await buildMemorySnapshot());
  }

  if (req.method === "POST" && req.url === "/api/channel") {
    const body = await readBody(req);
    if (!["qq", "imessage"].includes(body.channel)) {
      return sendJson(res, 400, { error: "Unknown channel" });
    }
    if (body.channel === 'imessage' && !isMac && body.enabled) return sendJson(res, 400, { error: 'iMessage 仅支持 macOS。' });
    state.channels[body.channel] = Boolean(body.enabled);
    if (body.channel === "imessage") updateIMessagePoller();
    return sendJson(res, 200, buildPublicState());
  }

  if (req.method === "POST" && req.url === "/api/imessage/trusted-handles") {
    const body = await readBody(req);
    if (Array.isArray(body.trustedHandles)) {
      state.imessage.trustedHandles = normalizeList(body.trustedHandles);
      await saveSettings();
    }
    return sendJson(res, 200, buildPublicState());
  }

  if (req.method === "POST" && req.url === "/api/imessage/reply-handle") {
    const body = await readBody(req);
    state.imessage.replyHandle = String(body.replyHandle || "").trim();
    await saveSettings();
    return sendJson(res, 200, buildPublicState());
  }

  if (req.method === "POST" && req.url === "/api/unified-memory/settings") {
    const body = await readBody(req);
    state.unifiedMemory.autoWriteOnSkillRecall = Boolean(body.autoWriteOnSkillRecall);
    state.unifiedMemory.autoWriteOnIMessageRecall = Boolean(body.autoWriteOnIMessageRecall);
    state.unifiedMemory.manualHandoffCommand = Boolean(body.manualHandoffCommand);
    await saveSettings();
    return sendJson(res, 200, buildPublicState());
  }

  if (req.method === "POST" && req.url === "/api/memory/clear") {
    const body = await readBody(req);
    const scope = String(body.scope || "").trim();
    const id = body.id == null ? "" : String(body.id);
    if (scope === "remoteExecution") {
      state.remoteExecution.memory.entries = [];
      await saveRemoteExecutionMemory();
      return sendJson(res, 200, await buildMemorySnapshot());
    }
    if (scope === "imessage") {
      if (id) delete state.imessage.memory.entries[id];
      else state.imessage.memory.entries = {};
      await saveIMessageMemory();
      return sendJson(res, 200, await buildMemorySnapshot());
    }
    return sendJson(res, 400, { error: "Unknown memory scope" });
  }

  if (req.method === "POST" && req.url === "/api/qq/event") {
    const event = enrichQqEvent(await readBody(req));
    delete event.lifeContactToken; delete event.lifeContactEvidence;
    if (!isPrivateMemoryEvent(event)) return sendJson(res, 200, { ignored: true, reason: 'Private-only mode' });
    const decision = shouldRespondToQq(event);
    let reply = null;
    let error = null;
    let commandAction = null;
    if (decision.ok) {
      try {
        commandAction = buildQqCommandAction(event);
        reply = decision.reply || commandAction?.reply || buildBoundaryReply(event) || await buildModelReply(event);
      } catch (caught) {
        error = publicFailure(caught);
        reply = caught.code === 'RUNTIME_BUDGET_BLOCKED' ? error : `${pickActionBeat(event)}这边刚刚卡了一下，等我再试一次。`;
      }
    }
    const record = {
      id: crypto.randomUUID(),
      receivedAt: new Date().toISOString(),
      source: "qq",
      event,
      decision,
      reply,
      error
    };
    // This endpoint previews a reply; no QQ delivery occurred to remember.
    if (record.reply && commandAction?.afterSend) await commandAction.afterSend();
    state.qq.events.unshift(record);
    state.qq.events = state.qq.events.slice(0, 30);
    return sendJson(res, 200, { status: "ok" });
  }

  if (req.method === 'POST' && req.url === '/api/onebot/event') {
    const payload = await readBody(req);
    if (serviceLifecycle?.stopping) return sendJson(res, 503, { error: 'Hub stopping; retry later' });
    if (payload.post_type !== 'message' || payload.message_type !== 'private' || payload.group_id != null) return sendJson(res, 200, { ignored: true, reason: 'Private-only mode' });
    delete payload.lifeContactToken;
    delete payload.hubContactToken;
    delete payload.hubContactContext;
    const incoming = enrichQqEvent(normalizeOneBotEvent(payload));
    let contactToken;
    const observeContact = lifeContacts && isLifeReplyEligible(incoming);
    if (lifeContacts && isLifeContactEligible(incoming) && isExplicitContactStop(incoming)) {
      // Signature and private admission were checked first. Observe before the
      // batching delay and workload limit so a stop fences in-flight sends.
      contactToken = await lifeContacts.observeIncoming(incoming);
      if (contactToken.stop) {
        const timing = createReplyTiming();
        const record = { id: crypto.randomUUID(), receivedAt: new Date(timing.receivedAt).toISOString(),
          source: 'onebot', event: incoming, decision: { ok: true, status: '已停止联系', reason: 'contact-stop' },
          timings: timing, completedAt: new Date().toISOString(), reply: null, send: null, error: null };
        state.qq.events.unshift(record); state.qq.events = state.qq.events.slice(0, 30);
        await saveReplyTiming(record);
        return sendJson(res, 200, { status: 'ok', contact: 'stopped' });
      }
    }
    if (activeEvents >= 16) return sendJson(res, 503, { error: 'Hub busy; retry later' });
    activeEvents++;
    try {
      // A rejected ordinary callback is not consumed. Reserve workload before
      // awaiting storage so concurrent callbacks cannot all pass the limit.
      if (observeContact) {
        contactToken = await lifeContacts.observeIncoming(incoming);
        lifeConversation?.observeIncoming(incoming, contactToken);
      }
    } catch (error) { activeEvents--; throw error; }
    // Acknowledge immediately: Codex can take minutes, longer than bridge HTTP timeouts.
    sendJson(res, 200, {});
    messageBatches.push(payload, { contactToken, contactEvidence: contactEvidenceFor(incoming, contactToken) }).catch(error => console.error('OneBot event failed:', error.message))
      .finally(() => { activeEvents--; });
    return true;
  }

  return false;
}

async function serveStatic(req, res) {
  const rawPath = req.url === "/" ? "/client.html" : req.url.split("?")[0];
  const decoded = decodeURIComponent(rawPath);
  if (decoded.split(/[/\\]/).includes('..') || decoded.includes(':') || decoded.includes('\0')) {
    res.writeHead(403); res.end('Forbidden'); return;
  }
  const safePath = normalize(decoded);
  const filePath = join(publicDir, safePath);

  try {
    const body = await readFile(filePath);
    res.writeHead(200, { "content-type": mimeTypes[extname(filePath)] || "application/octet-stream", ...corsHeaders() });
    res.end(body);
  } catch {
    res.writeHead(404, { "content-type": "text/plain; charset=utf-8", ...corsHeaders() });
    res.end("Not found");
  }
}

await loadSettings();
state.qq.privateOnly = localConfig.qqPrivateOnly === true;
if (localConfig.assistantName) assistantName = localConfig.assistantName;
assistantMentionAliases = normalizeList([...assistantMentionAliases, '@' + assistantName]);
if (localConfig.chatModel) state.ai.model = localConfig.chatModel;
if (isValidReasoningEffort(localConfig.chatReasoningEffort)) state.ai.reasoningEffort = localConfig.chatReasoningEffort;
if (Array.isArray(localConfig.ownerUserIds)) state.qq.ownerUserIds = normalizeList(localConfig.ownerUserIds);
await mkdir(localConfig.workspace, { recursive: true });
await mkdir(qqStickerDir, { recursive: true });
await loadIMessageMemory();
await loadRemoteExecutionMemory();
updateIMessagePoller();

const world = localConfig.world?.enabled ? await createWorld({ projectDir, config: localConfig, runtimeBudget,
  ...(localConfig.life?.enabled === true ? { recordExperience: input => {
    if (!lifeTimeline) throw Error('Life timeline is not ready for reading experiences');
    return lifeTimeline.recordExperience(input).then(result => { pumpLifeConversation(); return result; });
  } } : {}) }) : null;
const handleWorld = world ? createWorldHttp(world, { projectDir }) : null;
if (localConfig.life?.enabled === true) {
  const directory = join(dataDir, 'life');
  lifeTimeline = await createLifeTimeline({ directory });
  try {
    personalLifeState = createLifeState({ timeline: lifeTimeline });
    // Validate the recovered projection before accepting a chat or planning call.
    personalLifeState.snapshot();
    // Replay only durable reading outcomes. This does not reopen pages or call
    // a model, and must finish before any planning or private chat sees state.
    await world?.flushLifeExperiences();
    personalLifeState.snapshot();
    lifeContacts = await createLifeContacts({ directory, timeline: lifeTimeline });
    lifeConversation = await createLifeConversation({ directory, timeline: lifeTimeline, contacts: lifeContacts,
      readContext: readLifeConversationContext, decide: decideLifeConversation, dispatch: dispatchLifeConversation,
      isEligible: scope => isLifeContactEligible(contactEventFor(scope)) });
    lifeReplies = await createLifeReplies({ directory, timeline: lifeTimeline, contacts: lifeContacts,
      isEligible: isLifeReplyEligible,
      sendStatus: async (event, text) => {
        if (!isLifeReplyEligible(event)) return { ok: false };
        const statusEvent = { ...event, lifeStatusActivityId: lifeTimeline.availability({ scope: memoryScope(event) }).activityId };
        return inReplyOrder(`private:${event.senderId}`, () => sendCurrentPrivateSegments(statusEvent, [{ type: 'text', data: { text } }]));
      },
      reply: resumeLifeReply });
    if (localConfig.life.planning?.enabled === true) {
      if (!world) throw Error('生活规划需要启用world以复用受限模型和预算');
      lifePlanner = await createLifePlanner({ directory, timeline: lifeTimeline, personalState: personalLifeState,
        enforceDailyLimit: localConfig.runtimeBudget?.mode !== 'observe',
        decide: context => world.planLife(context) });
      lifeBrowsing = createLifeBrowsing({ timeline: lifeTimeline, world });
      lifeProactive = createLifeProactive({ timeline: lifeTimeline, contacts: lifeContacts,
        readCandidate: readLifeContactCandidate, decide: decideLifeContact,
        isEligible: scope => isLifeContactEligible(contactEventFor(scope)), dispatch: dispatchLifeContact });
    }
  } catch (error) { await lifeConversation?.close(); await lifeReplies?.close(); await lifeContacts?.close(); await lifeTimeline.close(); await world?.close(); throw error; }
  reportLifeWarnings();
}
// Once planning owns the timeline, the old autonomous browser timer must not compete with it.
if (!lifePlanner) world?.startScheduler();
const handleLifeObserver = createLifeObserverHttp({ readSnapshot: () => ({
  enabled: Boolean(lifeTimeline),
  snapshot: lifeTimeline?.snapshot(),
  diagnostics: lifeTimeline?.diagnostics
}) });

const server = createServer(async (req, res) => {
  if (serviceLifecycle?.stopping) {
    res.setHeader('Connection', 'close');
    return sendJson(res, 503, { error: 'Hub stopping; retry later' });
  }
  activeHttpRequests++;
  try {
    // Observer authorizes its developer boundary before any general API route.
    if (handleLifeObserver(req, res)) return;
    // Local UI only. Reject cross-origin browser writes and DNS rebinding.
    const host = String(req.headers.host || '').split(':')[0];
    if (!['localhost', '127.0.0.1'].includes(host)) return sendJson(res, 403, { error: 'Local host required' });
    const origin = req.headers.origin;
    if (origin && origin !== 'http://' + req.headers.host) return sendJson(res, 403, { error: 'Cross-origin access denied' });
    if (handleWorld && await handleWorld(req, res)) return;
    if (req.method === 'POST' && req.url === '/api/onebot/event') {
      let size = 0; const chunks = [];
      for await (const chunk of req) { size += chunk.length; if (size > 1024 * 1024) return sendJson(res, 413, { error: 'Body too large' }); chunks.push(chunk); }
      const raw = Buffer.concat(chunks);
      if (!validSignature(raw, req.headers['x-signature'], oneBotSecret)) return sendJson(res, 401, { error: 'Invalid OneBot signature' });
      req.body = JSON.parse(raw.toString('utf8'));
    }
    if (serviceLifecycle?.stopping) return sendJson(res, 503, { error: 'Hub stopping; retry later' });
    if (req.url?.startsWith("/api/")) {
      const handled = await handleApi(req, res);
      if (handled !== false) return;
    }
    await serveStatic(req, res);
  } catch (error) {
    sendJson(res, 500, { error: error.message });
  } finally { activeHttpRequests--; }
});

// A first deployment has to be able to tell what is actually wired up. This
// prints capability state only; it never reads message content or credentials.
async function reportStartupReadiness() {
  const owners = Array.isArray(localConfig.ownerUserIds) ? localConfig.ownerUserIds : [];
  const life = localConfig.life?.enabled === true;
  const rows = [
    [owners.length > 0, '管理员 QQ', owners.join(', ') || '未配置：任何私聊都不会得到回应'],
    [Boolean(oneBotSecret), 'OneBot 回调密钥', oneBotSecret ? '已配置' : '未配置：所有回调都会以 401 拒绝'],
    [state.channels.qq === true, 'QQ 通道', state.channels.qq ? '已开启' : '已关闭：只有后台指令可用'],
    [life, '生活时间线', life ? '已启用' : '未启用：不规划、不主动联系'],
    [life && localConfig.life?.planning?.enabled === true, '生活规划', life && localConfig.life?.planning?.enabled === true ? '已启用' : '未启用：需 life.enabled 与 life.planning.enabled 同时为真'],
    [localConfig.world?.enabled === true, '网页浏览', localConfig.world?.enabled !== true ? '未启用：生活规划也无法运行'
      : (localConfig.world.executablePath ? (localConfig.world.autoEnabled ? '可阅读（含自主探索）' : '可阅读（仅由生活时间线触发）')
        : '未配置 world.executablePath：阅读会在需要时失败，规划不受影响')],
    [true, '额度模式', localConfig.runtimeBudget?.mode === 'observe' ? 'observe：只记录、不拦截' : 'strict：未校准时会拒绝模型调用']
  ];
  const missing = rows.filter(([ok]) => !ok).length;
  console.log(`知微配置：${localConfigPath(projectDir)}${missing ? `（${missing} 项未就绪）` : '（全部就绪）'}`);
  for (const [ok, label, detail] of rows) console.log(`  ${ok ? 'OK  ' : 'TODO'} ${label}：${detail}`);
  if (!owners.length || !oneBotSecret) console.log('  提示：先运行 npm run setup 完成初始化，再启动服务。');
}

server.listen(Number(process.env.PORT || 3789), '127.0.0.1', () => {
  console.log(`知微 chat hub: http://127.0.0.1:${process.env.PORT || 3789}`);
  void reportStartupReadiness();
});

async function runPrivateTask(text, skill, history, event = {}) {
  if (!isPrivateMemoryEvent(event) || !event.isOwner) throw Error('Private task requires an authenticated owner');
  await ensureCodexReplyWorkspace();
  const outputPath = join(codexTmpDir, crypto.randomUUID() + '.qq-task.txt');
  const prompt = [
    '你正在通过 QQ 管理员私聊执行任务。用中文汇报结果和验证情况。',
    event.fullAccess ? '此任务由管理员确认使用完全访问。仅执行本次请求的操作，遵守本机策略和适用的权限约束。' : '仅在指定工作目录内修改文件。需要额外权限或外部发送时说明阻塞，不绕过沙箱。',
    '当前系统：' + process.platform + '；工作目录：' + localConfig.workspace,
    process.platform === 'win32'
      ? 'Windows 上使用 PowerShell 和 Windows 路径，不调用 AppleScript 或 macOS 命令。'
      : 'Linux 上使用 bash 和 POSIX 路径，不调用 PowerShell、osascript 或 macOS 专有命令。',
    skillContext(installedSkills, skill),
    await unifiedMemory.formatForPrompt({ scope: memoryScope(event), query: text }),
    '之前的任务对话（仅作上下文，不重新执行）：' + JSON.stringify(history),
    '本次经管理员确认的任务：', text
  ].join('\n\n');
  const args = ['exec', '--ephemeral', '--skip-git-repo-check', '-s', event.fullAccess ? 'danger-full-access' : 'workspace-write',
    '-C', localConfig.workspace, '-o', outputPath];
  if (localConfig.remoteModel) args.push('-m', localConfig.remoteModel);
  args.push('-');
  await runCodexCli(args, prompt, { budgetPurpose: 'qq-task', cwd: localConfig.workspace, timeout: 600000, env: { ...process.env } });
  const reply = (await readFile(outputPath, 'utf8')).trim();
  await unifiedMemory.write({ scope: memoryScope(event), type: 'projectNote', source: 'qq-cli-task',
    summary: `任务：${text.slice(0, 600)}\n结果：${reply.slice(0, 1200)}` });
  return reply.length > 3500 ? reply.slice(0, 3300) + '\n\n完整结果：' + outputPath : reply || '任务结束，但未返回可读结果。';
}

let activeEvents = 0;
const messageBatches = new MessageBatches({ deliver: processOneBotEvent });
let timingLogWrites = Promise.resolve();
function saveReplyTiming(record) {
  if (!record?.timings) return Promise.resolve();
  // Keep diagnostics across restarts, without copying chat text, pictures or tokens.
  const line = JSON.stringify({ id: record.id, messageId: record.event.raw?.message_id,
    messageIds: record.event.raw?.batched_message_ids || [record.event.raw?.message_id].filter(id => id != null),
    mergedMessageIds: record.event.mergedMessageIds,
    status: record.decision?.status,
    mergedInto: record.event.queueDisposition?.targetMessageId,
    recordedAt: new Date().toISOString(), timings: record.timings }) + '\n';
  const task = timingLogWrites.then(async () => {
    const path = join(projectDir, 'runtime', 'logs', 'qq-timings.jsonl');
    await mkdir(join(projectDir, 'runtime', 'logs'), { recursive: true });
    const size = await stat(path).then(s => s.size).catch(() => 0);
    if (size > 2 * 1024 * 1024) await rename(path, path + '.previous');
    await appendFile(path, line);
  });
  timingLogWrites = task.catch(() => { persistenceFailed = true; console.error('Could not save QQ timing diagnostics'); });
  return timingLogWrites;
}
let localConfigWrites = Promise.resolve();
serviceLifecycle = createServiceLifecycle({
  stopAccepting: () => new Promise((resolve, reject) => {
    server.close(error => error && error.code !== 'ERR_SERVER_NOT_RUNNING' ? reject(error) : resolve());
    server.closeIdleConnections?.();
  }),
  stopBackground: () => {
    clearInterval(lifeTimer); lifeTimer = null;
    clearInterval(imessagePollTimer); imessagePollTimer = null;
    stopRemoteExecutionIdleTimer();
    if (hubCommands.shutdownTimer) clearTimeout(hubCommands.shutdownTimer);
    return world?.close();
  },
  pending: () => activeEvents + activeHttpRequests + activeBackgroundTasks + activeCliProcesses + Number(imessagePolling),
  flush: async () => {
    await Promise.all([localConfigWrites, timingLogWrites]);
    try { await lifeConversation?.close(); await lifeBrowsing?.close(); await lifeProactive?.close(); await lifePlanner?.close(); await lifeReplies?.close(); await lifeContacts?.close(); }
    finally { try { await lifeTimeline?.close(); } finally { await runtimeBudget.close(); } }
    if (persistenceFailed) throw Error('A configuration or timing write failed');
  }
});
process.on('SIGTERM', () => { void serviceLifecycle.stop('SIGTERM'); });
process.on('SIGINT', () => { void serviceLifecycle.stop('SIGINT'); });
const hubCommands = new HubCommands({ config: localConfig, state, memory: unifiedMemory, world,
  shutdown: () => serviceLifecycle.stop('/关机'),
  workspace: projectDir, saveSettings,
  persist: () => {
    const task = localConfigWrites.then(() => writeFile(localConfigPath(projectDir), JSON.stringify(localConfig, null, 2)));
    localConfigWrites = task.catch(() => { persistenceFailed = true; }); return task;
  }
});
// Observation, planning and catch-up have independent in-flight guards: a slow
// model cannot stop time advancing. Planning remains explicitly opt-in.
if (lifeTimeline) {
  const requestedInterval = Number(localConfig.life.tickIntervalMs);
  // Starts can be held for thirty seconds. Keep observation and consumption
  // within that window even when an activity is created by another writer.
  const interval = Number.isFinite(requestedInterval) ? Math.max(250, Math.min(15000, requestedInterval)) : 15000;
  lifeTimer = setInterval(() => {
    if (lifeTickPending || serviceLifecycle.stopping) return;
    lifeTickPending = true;
    // A slow reply must not stop observation of the personal timeline. Track
    // the state tick and network/model drain independently during shutdown too.
    backgroundTask(lifeTimeline.tick()).then(() => {
      reportLifeWarnings();
      pumpLifeConversation();
      if (!lifeActionsPending && !serviceLifecycle.stopping && (lifeBrowsing || lifeProactive)) {
        lifeActionsPending = true;
        backgroundTask(Promise.all([lifeBrowsing?.tick(), lifeProactive?.tick()]))
          .then(() => pumpLifeConversation())
          .catch(() => { persistenceFailed = true; console.error('Life action failed; durable claims preserved'); })
          .finally(() => { lifeActionsPending = false; });
      }
      if (lifePlanner && !lifePlanningPending && !serviceLifecycle.stopping) {
        lifePlanningPending = true;
        backgroundTask(lifePlanner.tick())
          .then(() => pumpLifeConversation())
          .catch(() => { persistenceFailed = true; console.error('Life planning persistence failed; stored state preserved'); })
          .finally(() => { lifePlanningPending = false; });
      }
      if (lifeDrainPending || serviceLifecycle.stopping) return;
      lifeDrainPending = true;
      backgroundTask(lifeReplies.drain())
        .catch(() => { persistenceFailed = true; console.error('Life reply drain failed; stored state preserved'); })
        .finally(() => { lifeDrainPending = false; });
    }).catch(() => { persistenceFailed = true; console.error('Life timeline tick failed; stored state preserved'); })
      .finally(() => { lifeTickPending = false; });
  }, interval);
}

function reportLifeWarnings() {
  for (const warning of lifeTimeline?.diagnostics.warnings || []) {
    if (lifeWarningsSeen.has(warning)) continue;
    lifeWarningsSeen.add(warning);
    console.warn(warning);
  }
}

function pumpLifeConversation() {
  if (!lifeConversation || lifeConversationPending || serviceLifecycle?.stopping) return;
  lifeConversationPending = true;
  backgroundTask(lifeConversation.tick())
    .catch(() => { persistenceFailed = true; console.error('Life conversation transition failed; stored claims preserved'); })
    .finally(() => { lifeConversationPending = false; });
}

function isLifeContactEligible(event) {
  const current = enrichQqEvent(event);
  return state.channels.qq && isPrivateMemoryEvent(current)
    && !/^\s*\//.test(current.text || '') && !isBannedQqSender(current)
    && (localConfig.allowOtherPrivateChats === true || isMac || current.isOwner);
}

// Only authenticated ingress constructs this evidence. Keep one bounded latest
// own-text message, separately from any batch/quote reconstruction.
function contactEvidenceFor(event, token) {
  if (!token || token.stop) return undefined;
  const text = Array.isArray(event.raw?.message) ? event.raw.message.filter(part => part?.type === 'text')
    .map(part => String(part.data?.text || '')).join('') : String(event.text || '').replace(/\[CQ:[^\]]*\]/gi, '');
  if (!text || text.length > 12000) return undefined;
  return { token: structuredClone(token), event: { type: 'private_message', senderId: String(event.senderId), text,
    raw: { message_id: event.raw?.message_id, message: [{ type: 'text', data: { text } }] } } };
}

function contactEventFor(scope) {
  return enrichQqEvent({ type: 'private_message', senderId: String(scope).replace(/^qq:private:/, ''), text: '', raw: {} });
}

async function readLifeContactCandidate({ scope, motive }) {
  const recalled = await unifiedMemory.recall({ scope, query: motive, limit: 2 });
  const sources = recalled.entries.map(entry => ({ kind: 'private-memory', ref: `memory:${entry.id}`, scope }));
  let context = '';
  for (const block of [recalled.context, await unifiedMemory.formatPrivateProfile({ scope }),
    personalLifeState.formatContext({ scope }), lifeTimeline.formatContext({ scope })]) {
    if (block && context.length + block.length + 1 <= 12000) context += (context ? '\n' : '') + block;
  }
  return { sources, score: recalled.entries.filter(entry => entry.reason === 'relevant').length, context };
}

async function decideLifeContact(input) {
  const prompt = buildProactivePrompt(await loadAssistantSkillBrief(), input);
  const model = localConfig.privateChatModel || localConfig.world?.model || (state.ai.model === 'default' ? undefined : state.ai.model);
  const runner = createWorldModel({ directory: join(dataDir, 'life', 'contact-model'), model,
    reasoningEffort: localConfig.privateChatReasoningEffort || state.ai.reasoningEffort,
    proxy: localConfig.codexProxy, schema: proactiveDecisionSchema, timeoutMs: 300000 });
  const result = await runtimeBudget.run({ purpose: 'life-contact' }, () => runner({ prompt }));
  return result.text;
}

async function readLifeConversationContext({ scope, event, thought }) {
  const recalled = await unifiedMemory.recall({ scope,
    query: [event.text, thought.text].filter(Boolean).join('\n'), limit: 4 });
  let context = '';
  for (const block of [recalled.context, await unifiedMemory.formatPrivateProfile({ scope }),
    personalLifeState.formatContext({ scope }), lifeTimeline.formatContext({ scope })]) {
    if (block && context.length + block.length + 1 <= 12000) context += (context ? '\n' : '') + block;
  }
  return { context, sources: recalled.entries.slice(0, 4).map(entry => ({ kind: 'private-memory', ref: `memory:${entry.id}`, scope })) };
}

async function decideLifeConversation(input) {
  const prompt = buildConversationPrompt(await loadAssistantSkillBrief(), input);
  const model = localConfig.privateChatModel || localConfig.world?.model || (state.ai.model === 'default' ? undefined : state.ai.model);
  const runner = createWorldModel({ directory: join(dataDir, 'life', 'conversation-model'), model,
    reasoningEffort: localConfig.privateChatReasoningEffort || state.ai.reasoningEffort,
    proxy: localConfig.codexProxy, schema: conversationDecisionSchema, timeoutMs: 25000 });
  const result = await backgroundTask(runtimeBudget.run({ purpose: 'life-conversation' }, () => {
    // Quota admission can wait. Recheck at the actual model boundary, after
    // that wait, so an expired comparison never starts a new model process.
    const plan = lifeTimeline.snapshot().plans.find(item => item.id === input.plan.id);
    const current = lifeContacts.capture(input.scope);
    const choice = lifeConversation.snapshot(input.scope).choices.find(item => item.id === input.decisionId);
    if (serviceLifecycle?.stopping || plan?.status !== 'planned' || plan.startTransition?.status !== 'pending'
      || plan.startTransition.id !== input.decisionId || Date.now() < plan.startTransition.claimedAt
      || Date.now() >= input.deadline || current?.epoch !== input.token.epoch || current?.sequence !== input.token.sequence
      || choice?.status !== 'generating' || !lifeContacts.isCurrent(input.token, { latest: true }) || !isLifeContactEligible(contactEventFor(input.scope))) {
      throw Error('Conversation choice is no longer current');
    }
    return runner({ prompt });
  }));
  return result.text;
}

async function dispatchLifeConversation({ decisionId, scope, token, text, guard }) {
  const event = contactEventFor(scope);
  const result = await inReplyOrder(`private:${event.senderId}`, () => lifeContacts.sendIfCurrent(token, () => {
    if (serviceLifecycle?.stopping || !isLifeContactEligible(event) || !guard()) return { ok: false, reason: 'life-choice-expired' };
    return sendOneBotSegments('private', Number(event.senderId), [{ type: 'text', data: { text } }]);
  }));
  if (result?.ok) {
    try { await unifiedMemory.writeOutbound({ scope, replyText: text, intentId: `life-conversation:${decisionId}`,
      sentMessageIds: result.body?.data?.message_id == null ? [] : [String(result.body.data.message_id)] }); }
    catch { persistenceFailed = true; console.error('Could not save delivered activity farewell'); }
  }
  return result;
}

async function dispatchLifeContact({ ticket, scope, guard }) {
  const event = contactEventFor(scope);
  let sentText, sentId;
  const result = await inReplyOrder(`private:${event.senderId}`, () => lifeContacts.dispatch(ticket, text => {
    sentText = text;
    return sendOneBotSegments('private', Number(event.senderId), [{ type: 'text', data: { text } }]).then(sent => {
      sentId = sent.body?.data?.message_id; return sent;
    });
  }, { guard: () => !serviceLifecycle.stopping && isLifeContactEligible(event) && guard() }));
  if (result.ok) {
    // This is our initiative, not a fictional user turn or profile evidence.
    try { await unifiedMemory.writeOutbound({ scope, replyText: sentText, intentId: ticket.id,
      sentMessageIds: sentId == null ? [] : [String(sentId)] }); }
    catch { persistenceFailed = true; console.error('Could not save delivered proactive private memory'); }
  }
  return result;
}

function isLifeReplyEligible(event) {
  return isLifeContactEligible(event) && !hasUnhandledQqAudio(event);
}

async function resumeLifeReply(queuedEvent, { resumeContext, episodeId } = {}) {
  const event = enrichQqEvent({ ...queuedEvent, lifeResumeContext: [resumeContext,
    '这是忙碌期间消息的一次合并回应。可以只自然提一句当前情况；无需逐条回答。只输出一条简短文字，不使用图片、表情附件或补查标记。'
  ].filter(Boolean).join('\n') });
  if (!isLifeReplyEligible(event) || !isCurrentLifeReply(event)) return { ok: false };
  event.lifeReplyTicket = lifeConversation?.beginReply(event);
  const timing = createReplyTiming();
  const record = { id: crypto.randomUUID(), receivedAt: new Date().toISOString(), source: 'life-resume',
    episodeId, event, decision: { ok: true, status: '生成中' }, timings: timing, reply: null, send: null, error: null };
  state.qq.events.unshift(record); state.qq.events = state.qq.events.slice(0, 30);
  return replyTimingContext.run(timing, async () => {
    let sendStarted = false;
    try {
      const reply = await buildModelReply(event);
      record.reply = stripQqImageAttachmentMarkers(reply).trim();
      if (!record.reply) record.reply = '现在有空了，刚才的消息我看到了。';
      // Permissions may have changed while the model was running. Do not send
      // queued messages to a disabled channel or newly excluded contact.
      if (!isCurrentLifeReply(event) || lifeTimeline.availability({ scope: memoryScope(event) }).busy) return { ok: false };
      record.decision.status = '发送中';
      sendStarted = true;
      record.send = await measureSend(timing, () => inReplyOrder(`private:${event.senderId}`, () =>
        sendCurrentPrivateSegments(event, [{ type: 'text', data: { text: record.reply } }])));
      if (record.send?.ok) {
        const sentId = record.send.body?.data?.message_id;
        if (sentId != null) event.sentMessageIds = [String(sentId)];
        try { await moodState.commit(event); }
        catch { persistenceFailed = true; record.moodSaved = false; console.error('Could not save completed life reply mood'); }
        try { await rememberQqExchange(event, record.reply); }
        catch { persistenceFailed = true; record.memorySaved = false; console.error('Could not save completed life reply memory'); }
      }
      return { ok: record.send?.ok === true };
    } catch (error) {
      record.error = publicFailure(error);
      if (error.code === 'RUNTIME_BUDGET_BLOCKED' && !sendStarted && isCurrentLifeReply(event)
        && !lifeTimeline.availability({ scope: memoryScope(event) }).busy) {
        // One local status response replaces the single failed catch-up attempt.
        // It is not a personal experience or a conversation-memory entry.
        sendStarted = true;
        record.reply = record.error;
        try {
          record.send = await measureSend(timing, () => inReplyOrder(`private:${event.senderId}`, () =>
            sendCurrentPrivateSegments(event, [{ type: 'text', data: { text: record.reply } }])));
        } catch { /* The pending attempt is already consumed; never resend. */ }
      }
      return { ok: false, uncertain: sendStarted };
    } finally {
      lifeConversation?.endReply(event.lifeReplyTicket);
      record.decision.status = record.send?.ok ? '已回复' : '回复失败';
      record.completedAt = new Date().toISOString();
      await saveReplyTiming(record);
    }
  });
}

async function processOneBotEvent(payload, context = {}) {
    const timing = createReplyTiming(payload.hubReceivedAt, payload.hubBatchCompletedAt);
    return replyTimingContext.run(timing, () => processTimedOneBotEvent(payload, timing, context));
}
async function processTimedOneBotEvent(payload, timing, context) {
    if (payload.post_type !== 'message' || payload.message_type !== 'private' || payload.group_id != null) return { ignored: true, reason: 'Private-only mode' };

    let event = enrichQqEvent(normalizeOneBotEvent(payload));
    // Check each original message. A retry of the first item must not discard
    // subsequent new messages gathered by the short batching window.
    let duplicate;
    if (payload.hubBatchMessages?.length) {
      const fresh = payload.hubBatchMessages.filter(item => !rememberEvent(getEventDedupeKey({ ...event, raw: item })));
      duplicate = fresh.length === 0;
      if (!duplicate) {
        payload = { ...payload, message_id: fresh[0].message_id, hubBatchMessages: fresh,
          batched_message_ids: fresh.map(item => item.message_id),
          message: fresh.flatMap((item, index) => [...(index ? [{ type: 'text', data: { text: '\n' } }] : []), ...item.message]),
          raw_message: fresh.every(item => typeof item.raw_message === 'string') ? fresh.map(item => item.raw_message).join('\n') : undefined };
        event = enrichQqEvent(normalizeOneBotEvent(payload));
      }
    } else duplicate = rememberEvent(getEventDedupeKey(event));
    if (duplicate) {
      const record = {
        id: crypto.randomUUID(),
        receivedAt: new Date().toISOString(),
        source: "onebot",
        event,
        decision: { ok: false, status: '忽略', reason: "Duplicate OneBot message ignored" },
        timings: timing,
        completedAt: new Date().toISOString(),
        reply: null,
        error: null,
        send: null
      };
      state.qq.events.unshift(record);
      state.qq.events = state.qq.events.slice(0, 30);
      await saveReplyTiming(record);
      return ({ status: "ok", duplicate: true });
    }

    event.timings = timing;
    event.lifeContactToken = context.contactToken;
    event.lifeContactEvidence = context.contactEvidence;
    const admission = shouldRespondToQq(event);
    const contactCurrent = !admission.ok || isCurrentLifeReply(event);
    if (!admission.ok || !contactCurrent) {
      const record = { id: crypto.randomUUID(), receivedAt: new Date(timing.receivedAt).toISOString(),
        source: 'onebot', event, decision: { ...admission, ok: false, status: '忽略',
          ...(!contactCurrent ? { reason: 'contact-epoch-superseded' } : {}) }, timings: timing,
        completedAt: new Date().toISOString(), reply: null, send: null, error: null };
      state.qq.events.unshift(record); state.qq.events = state.qq.events.slice(0, 30);
      await saveReplyTiming(record);
      return { status: 'ok', ignored: true };
    }
    if (lifeReplies && !/^\s*\//.test(event.text || '')) {
      await lifeTimeline.tick();
      pumpLifeConversation();
      const disposition = await lifeReplies.receive(event);
      if (disposition.handled) {
        const record = { id: crypto.randomUUID(), receivedAt: new Date(timing.receivedAt).toISOString(),
          source: 'onebot', event, decision: { ok: true, status: '生活消息已接收', reason: disposition.kind },
          timings: timing, completedAt: new Date().toISOString(), reply: null, send: null, error: null };
        state.qq.events.unshift(record); state.qq.events = state.qq.events.slice(0, 30);
        await saveReplyTiming(record);
        return { status: 'ok', life: disposition.kind };
      }
    }
    event.lifeReplyTicket = !/^\s*\//.test(event.text || '') ? lifeConversation?.beginReply(event) : undefined;
    try {
    await measurePreparation(timing, async () => {
      event = recentImages.attach(await attachReplyContext(event));
    });
    const decision = shouldRespondToQq(event);
    const record = { id: crypto.randomUUID(), receivedAt: new Date(timing.receivedAt).toISOString(),
      source: 'onebot', event, decision, timings: timing, reply: null, error: null, send: null };
    if (decision.ok) record.decision.status = '生成中';
    state.qq.events.unshift(record); state.qq.events = state.qq.events.slice(0, 30);
    let reply = null;
    let error = null;
    let commandAction = null;
    let modelReply = false;
    if (decision.ok) {
      try {
        commandAction = buildQqCommandAction(event);
        reply = await measurePreparation(timing, async () => {
          const prepared = decision.reply || await hubCommands.handle(event) || await privateTasks.handle(event) || commandAction?.reply || buildBoundaryReply(event);
          if (prepared) return prepared;
          const generated = await buildModelReply(event);
          modelReply = true;
          return generated;
        });
      } catch (caught) {
        error = publicFailure(caught);
        reply = caught.code === 'RUNTIME_BUDGET_BLOCKED' ? error : `${pickActionBeat(event)}这边刚刚卡了一下，等我再试一次。`;
      }
    }
    Object.assign(record, { reply, error });
    if (error && event.isOwner && event.type === 'private_message') record.reply = error;
    if (record.reply) record.decision.status = '发送中';
    if (record.reply && event.type === "private_message") {
      try {
        record.send = await measureSend(timing, () => sendOneBotPrivateReply(event, record.reply,
          { splitText: modelReply && !error && !/^\s*\//.test(event.text || '') }));
      } catch (error) {
        record.send = { ok: false, error: error.message };
      }
    }
    // A delivered prefix is the only reply that actually happened if a later
    // bubble failed or was superseded. Never remember unsent continuation text.
    if (record.send?.textComplete === false && record.send.deliveredText) {
      record.reply = record.send.deliveredText;
    }
    if (record.send?.reason === 'life-choice-replaced' && !event.lifeTransportStarted
      && !event.sentMessageIds?.length && isCurrentLifeReply(event)) {
      event.queueDisposition = await lifeReplies.defer(event);
      record.decision.reason = 'activity-transition-deferred';
    }
    if (record.reply && record.send?.ok !== false && commandAction?.afterSend) await commandAction.afterSend();
    if (record.reply && record.send?.ok === true && !error) {
      await moodState.commit(event).catch(() => console.error('Could not save QQ mood state'));
      try { await rememberQqExchange(event, record.reply); }
      catch { record.memorySaved = false; console.error('Could not save delivered private exchange'); }
    }
    if (record.reply || error) {
      record.decision.status = error || !record.send?.ok ? '回复失败' : record.send.textComplete === false ? '部分已回复' : '已回复';
      record.completedAt = new Date().toISOString();
      await saveReplyTiming(record);
    }
    if (!record.completedAt && !event.queueDisposition) {
      record.decision.status ||= '忽略';
      record.completedAt = new Date().toISOString();
      await saveReplyTiming(record);
    }
    return ({ status: "ok" });
    } finally { lifeConversation?.endReply(event.lifeReplyTicket); }
}

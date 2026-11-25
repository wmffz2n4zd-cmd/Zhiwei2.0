import { enabledCreativeKinds, withCreativeSchema, creativeDecisionPrompt, readCreativeDecision, prepareCreativeWork } from './private-creative-work.js';
import { creativeSpecGuidance, renderCreativeWork } from './creative-render.js';
import { isMac, userHome, resolveCodex, codexCommand, loadLocalConfig, discoverSkills, resolveChatSkill, skillContext, PrivateTasks } from './portable.js';
import { createServer } from "node:http";
import { HubCommands, isHubCommand } from './hub-commands.js';
import { isPrivateScope, privateEventScope, privateScopeId } from './private-scope.js';
import { isPwaEvent, privateQueueKey, privateInboundIds, privateLogicalReplyId, pwaPayloadForInbox,
  trustedPwaEvent, pwaIdentityCurrent, projectionEvent, pwaMessageId } from './private-transport.js';
import { normalizePrivatePayload } from './private-events.js';
import { buildStickerCatalog, formatStickerCatalog, buildImageSegment, formatImageSummary, resolveReplyMedia, stripImageAttachmentMarkers, buildChatStyleInstructions } from './shared-media.js';
import { createPwaStore } from './pwa-store.js';
import { createPwaAuth } from './pwa-auth.js';
import { createPwaHttp } from './pwa-http.js';
import { createPwaMedia } from './pwa-media.js';
import { createPwaHistory } from './pwa-history.js';
import { createPwaStickers } from './pwa-stickers.js';
import { pwaHistoryInstruction, parsePwaHistoryRequest, pwaHistoryFingerprint, formatPwaHistoryEvidence, pwaHistorySourcesCurrent } from './pwa-chat-history.js';
import { loadOrCreateVapidConfig, createPwaPushWorker } from './pwa-push.js';
import { memoryScope } from './unified-memory/index.js';
import { queryTokens } from './unified-memory/recall.js';
import { currentPwaImageInbox, restorePwaBusyInput, describePwaImageTurn, selectPwaImageTurn } from './pwa-image-turn.js';
import { MoodState, stripMoodMarkers } from './mood-state.js';
import { MessageBatches } from './message-batches.js';
import { replyTimingContext, createReplyTiming, measureModelCall, measurePreparation, measureSend } from './reply-timing.js';
import { classifyCliFailure, publicFailure } from './cli-errors.js';
import { runCliProcess } from './cli-process.js';
import { assertProxyReachable } from './proxy-control.js';
import { createWorld, createWorldHttp } from './world.js';
import { createWorldModel } from './world-model.js';
import { buildRuntimeCapabilities, renderRuntimeCapabilities } from './runtime-capabilities.js';
import { loadAssistantProfile } from './assistant-profile.js';
import { privateReplySettings, resolveReplyWriter } from './private-reply-settings.js';
import { loadPersonaRevision } from './persona-revision.js';
import { createReplyEvidence, createPrivateChatEvidence, buildLayeredReplyPrompt, buildWriterPrompt, sharedReplyContract } from './private-reply-context.js';
import { replyPlanSchema, parseReplyPlan, replyPlanPrompt, writerReplySchema, parseWriterReply, assembleReply, selectReplyVariant } from './private-reply-plan.js';
import { createServiceLifecycle } from './service-lifecycle.js';
import { writeJsonAtomic, readJsonRecoverableSync } from './atomic-file.js';
import { createTransientFiles, pruneTransientFiles } from './transient-files.js';
import { createLifeTimeline } from './life-timeline.js';
import { createLifeReplies } from './life-replies.js';
import { createLifeContacts, isExplicitContactStop, ownContactEvidence, isExplicitContactInvitation } from './life-contacts.js';
import { createLifePlanner } from './life-planner.js';
import { createLifeBrowsing } from './life-browsing.js';
import { createPrivateThoughtActions } from './private-thought-actions.js';
import { createSpacePublisher } from './space-publisher.js';
import { createSpaceCommentReplies } from './space-comment-replies.js';
import { createSpaceTimeline } from './space-timeline.js';
import { createListedSpaceReader } from './space-sources.js';
import { createLifeBrowseIntents, browseIntentDecisionSchema, buildLifeBrowseIntentPrompt } from './life-browse-intents.js';
import { createLifeProactive, proactiveDecisionSchema, buildProactivePrompt,
  proactiveRetrievalSchema, parseProactiveDecision, parseProactiveRetrieval, buildProactiveRetrievalPrompt } from './life-proactive.js';
import { lifeChatDecisionSchema, parseLifeChatDecision, lifeChatDecisionPrompt,
  chatReplyDecisionSchema, parseChatReplyDecision, chatReplyDecisionPrompt, withPrivateThoughtSchema } from './life-chat-decision.js';
import { approvePublicTopics, createPublicTopicCatalog, createChatRetrieval, formatRetrievalEvidence } from './chat-retrieval.js';
import { createPrivatePageRenderer } from './private-page-renderer.js';
import { createChatLookupAdapter } from './chat-retrieval-http.js';
import { createVideoReader, createVideoWorker, probeVideoDependencies, configuredVideoPlatforms, parseSharedVideoLinks, formatVideoEvidence } from './video-reader.js';
import { createVideoSourceContext } from './video-source-context.js';
import { withCurrentReplySignal } from './chat-reply-coordinator.js';
import { createLifeConversation, conversationDecisionSchema, buildConversationPrompt } from './life-conversation.js';
import { createLifeState } from './life-state.js';
import { createLifeObserverHttp } from './life-observer-http.js';
import { createConfiguredRuntimeBudget } from './runtime-budget-service.js';
import { createPrivateLearning, learningDecisionSchema } from './private-learning.js';
import { assertV201MemoryResetComplete } from './memory-reset-guard.js';
import { ensureStickerLeadText, sendTextThenSticker, inReplyOrder } from './sticker-replies.js';
import { spawn } from "node:child_process";
import { createHash } from 'node:crypto';
import { statSync } from 'node:fs';
import { access, mkdir, readFile, readdir, stat, writeFile, appendFile, rename } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { brotliDecompressSync } from "node:zlib";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const projectDir = join(__dirname, "..");
// A partially applied maintenance reset must be resumed before any writer starts.
await assertV201MemoryResetComplete({ dataDir: join(projectDir, 'data') });
// Private chat is the product boundary; legacy configuration cannot re-enable groups.
const localConfig = loadLocalConfig(projectDir);
const replySettings = privateReplySettings(localConfig);
const personaPolicy = replySettings.personaRevision ? await loadPersonaRevision({ path: join(projectDir, 'data', 'persona-revision.json'), expectedRevision: replySettings.personaRevision }) : null;
const servicePersonaToken = personaPolicy?.capture();
const lifeGenerationValidity = new Map();
const lifeGenerationSelections = new Map();
const lifeGenerationRoutes = new Map();
const personaCurrent = () => !personaPolicy || personaPolicy.isCurrent(servicePersonaToken);
const runtimeBudget = await createConfiguredRuntimeBudget({ projectDir, config: localConfig });
let serviceLifecycle = null;
let pwaStore = null, pwaAuth = null, pwaHttp = null, pwaMedia = null, pwaPush = null, pwaHistory = null, pwaStickers = null;
let pwaInboxSettledVersion = 0;
let pwaTimer = null, pwaPumpRunning = false, pwaProjectionRunning = false;
const pwaActiveInbox = new Set(), pwaActiveLogical = new Set();
const pwaConfig = localConfig.pwa || {};
const pwaWritable = () => pwaConfig.enabled === true && pwaConfig.readOnly !== true;
let lifeTimeline = null, lifeReplies = null, lifeContacts = null, lifePlanner = null, personalLifeState = null, lifeTimer = null;
let lifeFailure = null, lifeFailureRetryable = false, contactFailure = null;
const lifeAvailable = () => Boolean(lifeTimeline && !lifeFailure);
function suspendLife(error, { retryable = false } = {}) {
  if (!lifeFailure) console.error('Life subsystem unavailable; private contact boundaries remain active:', error?.message || 'unknown failure');
  lifeFailureRetryable = lifeFailure ? lifeFailureRetryable && retryable : retryable;
  lifeFailure = error || Error('Life subsystem unavailable');
}
let lifeBrowsing = null, lifeProactive = null, lifeActionsPending = false;
let privateThoughtActions = null, privateThoughtTickPending = false;
let spaceTimeline = null, spaceTickPending = false;
let spaceCommentReplies = null, spaceCommentTickPending = false;
let lifeBrowseIntents = null, lifeBrowseFailure = false, lifePlanningWork = null, lifeProactivePending = false;
const browseIntentsEnabled = localConfig.life?.enabled === true && localConfig.life?.planning?.enabled === true
  && localConfig.life?.browsingIntents?.enabled !== false;
const browseIntentsAvailable = () => Boolean(lifeAvailable() && lifeBrowseIntents && !lifeBrowseIntents.diagnostics().failed);
let lifeConversation = null, lifeConversationPending = false;
let lifeTickPending = false, lifeDrainPending = false, lifePlanningPending = false, lifeExperiencePending = false, temporaryFilesTimer = null;
const lifeWarningsSeen = new Set();
let activeHttpRequests = 0, activeBackgroundTasks = 0, activeCliProcesses = 0;
let persistenceFailed = false;
function backgroundTask(task) {
  activeBackgroundTasks++;
  return Promise.resolve(task).finally(() => { activeBackgroundTasks--; });
}
const installedSkills = discoverSkills(projectDir, localConfig);
const privateTasks = new PrivateTasks({
  skills: installedSkills,
  allowFullAccess: localConfig.allowFullAccessTasks === true,
  enabled: Boolean(localConfig.remoteEnabled && localConfig.pwa?.enabled),
  run: runPrivateTask
});
const publicDir = join(projectDir, "modules", "web-console", "public");
const codexWorkspaceDir = join(projectDir, 'runtime', 'chat-workspace');
const codexTmpDir = join(projectDir, "runtime", "replies");
let world = null;
const chatLookupAdapter = createChatLookupAdapter({
  renderPage: createPrivatePageRenderer(localConfig.world || {}),
  searchPublicNotes: (query, options) => world ? world.searchPublicNotes(query, options) : { status: 'failed', sources: [] }
});
const publicTopicCatalog = createPublicTopicCatalog();
const chatRetrieval = createChatRetrieval({ cacheDir: join(projectDir, 'runtime', 'chat-evidence'), adapter: chatLookupAdapter });
const videoPlatforms = configuredVideoPlatforms(localConfig.video?.platforms);
const videoSources = createVideoSourceContext({ platforms: videoPlatforms });
const videoTurnFacts = new WeakMap();
let videoReader = null;
if (localConfig.video?.enabled === true) {
  try {
    if (!videoPlatforms.length) throw Error('No enabled video platforms');
    const workerPath = join(projectDir, 'scripts', 'video-worker.py');
    const workerOptions = {
      platforms: videoPlatforms, workerPath, dependencyRoot: localConfig.video.dependencyRoot, pythonPath: localConfig.video.pythonPath || '/usr/bin/python3',
      nodePath: localConfig.video.nodePath || process.execPath, sessionBrowser: localConfig.video.sessionBrowser
    };
    const probe = await probeVideoDependencies({ ...workerOptions, directory: join(projectDir, 'tmp', 'video-probe') });
    if (probe.ready !== true) throw Error('Video dependencies unavailable');
    videoReader = createVideoReader({ directory: join(projectDir, 'tmp', 'video-evidence'), platforms: videoPlatforms,
      worker: createVideoWorker(workerOptions) });
  } catch { console.error('Optional video evidence unavailable; private text chat remains available'); }
}
const imessageScreenshotsDir = join(projectDir, "runtime", "imessage-screenshots");
const stickerDir = process.env.CODEX_REMOTE_CONTACT_STICKER_DIR || process.env.CODEX_REMOTE_CONTACT_QQ_STICKER_DIR || join(projectDir, "data", "qq-stickers");
const dataDir = join(projectDir, "data");
if (pwaConfig.enabled === true) {
  if (!/^https:\/\//.test(pwaConfig.origin || '')) throw Error('PWA requires an explicit HTTPS origin');
  const directory = pwaConfig.dataDirectory || join(dataDir, 'pwa');
  await mkdir(directory, { recursive: true, mode: 0o700 });
  pwaStore = createPwaStore({ path: pwaConfig.databasePath || join(directory, 'pwa.sqlite') });
  pwaAuth = createPwaAuth({ store: pwaStore });
  pwaMedia = await createPwaMedia({ directory: join(directory, 'media'), store: pwaStore,
    allowedOutboundRoots: [stickerDir] });
}
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

const privateVisionAvailable = true;

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

const codexCliPath = resolveCodex();
const codexModel = process.env.CODEX_REMOTE_CONTACT_CODEX_MODEL || localConfig.chatModel || (isMac ? "gpt-5.4-mini" : "default");
const codexReasoningEffort = process.env.CODEX_REMOTE_CONTACT_REASONING_EFFORT || "low";
const imessageCodexModel = process.env.CODEX_REMOTE_CONTACT_IMESSAGE_CODEX_MODEL || "gpt-5.4";
const imessageCodexReasoningEffort = process.env.CODEX_REMOTE_CONTACT_IMESSAGE_REASONING_EFFORT || "medium";
const mediaEnabled = process.env.CODEX_REMOTE_CONTACT_MEDIA !== "0";
const imessageMemoryLimit = Number(process.env.CODEX_REMOTE_CONTACT_IMESSAGE_MEMORY_LIMIT || 120);
const remoteExecutionMemoryLimit = Number(process.env.CODEX_REMOTE_CONTACT_REMOTE_EXECUTION_MEMORY_LIMIT || 160);
const remoteExecutionIdleTtlMs = Number(process.env.CODEX_REMOTE_CONTACT_REMOTE_EXECUTION_IDLE_TTL_MS || 15 * 60 * 1000);
const webLookupEnabled = process.env.CODEX_REMOTE_CONTACT_WEB_LOOKUP != null ? process.env.CODEX_REMOTE_CONTACT_WEB_LOOKUP !== "0" : localConfig.webLookup !== false;
const webSearchProvider = 'xiaohongshu';
// One bounded startup warm contains only application-owned public feed URLs.
// Ordinary replies read the resulting catalogue without waiting on HTTP.
if (webLookupEnabled) void backgroundTask(publicTopicCatalog.getTopics({})).catch(() => {});
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
const unifiedMemory = createUnifiedMemory({ memoryPath: unifiedMemoryPath, personaPolicy });
unifiedMemory.subscribeLearningInvalidation(event => chatRetrieval.invalidateScope(event.scope));
unifiedMemory.subscribeLearningInvalidation(event => event.scope === 'all' ? videoReader?.invalidateAll() : videoReader?.invalidate(event.scope));
unifiedMemory.subscribeLearningInvalidation(event => videoSources.invalidate(event.scope));
unifiedMemory.subscribeLearningInvalidation(event => privateThoughtActions?.invalidate(event.scope));
// Establish the durable initialized boundary before accepting any work. A lost
// existing store must never become a successful first-run empty conversation.
await unifiedMemory.ensureInitialized();
const moodState = new MoodState({ memory: unifiedMemory, enabled: localConfig.mood?.enabled === true });
let privateLearning = null;
try {
  privateLearning = await createPrivateLearning({ directory: join(dataDir, 'private-learning'),
    memory: unifiedMemory, personaPolicy, config: localConfig.privateLearning || {}, runModel: runPrivateLearningModel,
    onError: () => console.error('Optional private learning is unavailable; continuing without learned context') });
} catch {
  console.error('Optional private learning could not initialize; continuing ordinary chat');
}

const state = {
  ai: {
    privateReply: replySettings,
    provider: "codex-cli",
    model: codexModel || "default",
    reasoningEffort: codexReasoningEffort,
    imessageModel: imessageCodexModel,
    imessageReasoningEffort: imessageCodexReasoningEffort,
    workspace: codexWorkspaceDir
  },
  channels: {
    pwa: pwaConfig.enabled === true,
    imessage: isMac
  },
  privateChat: {
    enhancer: {
      enabled: mediaEnabled
    },
    webLookup: {
      enabled: webLookupEnabled
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
    codex: {
      path: codexCliPath,
      lastRunAt: null,
      lastDurationMs: null,
      lastOk: null,
      lastError: null,
      quota: null
    },
    webLookup: {
      enabled: webLookupEnabled,
      effectiveProvider: null,
      lastQuery: null,
      lastRunAt: null,
      lastDurationMs: null,
      lastOk: null,
      lastError: null
    }
  }
};

const seenPrivateMessageIds = new Map();
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
    if (size > 1024 * 1024) throw Object.assign(new Error('Request exceeds 1 MiB'), { statusCode: 413 });
    chunks.push(chunk);
  }
  if (chunks.length === 0) return {};
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8")); }
  catch { throw Object.assign(new Error('Invalid JSON request'), { statusCode: 400 }); }
}

async function loadSettings() {
  await mkdir(dataDir, { recursive: true });
  try {
    const body = readJsonRecoverableSync(settingsPath, { warn: message => console.warn(message) });
    const mediaSettings = body.privateChat?.enhancer ?? body.qq?.enhancer;
    if (mediaSettings && typeof mediaSettings === 'object') state.privateChat.enhancer.enabled = mediaSettings.enabled !== false;
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
      throw new Error('Unable to load settings safely', { cause: error });
    }
  }
}

async function saveSettings() {
  await mkdir(dataDir, { recursive: true });
  await writeJsonAtomic(
    settingsPath,
    {
      ...readJsonRecoverableSync(settingsPath, { missing: {}, warn: message => console.warn(message) }),
      version: 1,
      updatedAt: new Date().toISOString(),
      ai: {
        model: state.ai.model,
        reasoningEffort: state.ai.reasoningEffort,
        imessageModel: state.ai.imessageModel,
        imessageReasoningEffort: state.ai.imessageReasoningEffort
      },
      privateChat: { enhancer: { enabled: state.privateChat.enhancer.enabled } },
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
    }, { previous: true }
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
    ai: { ...state.ai, privateReply: { ...replySettings, ordinaryWriter: resolveReplyWriter(replySettings, { model: localConfig.privateChatModel || state.ai.model, reasoningEffort: localConfig.privateChatReasoningEffort || state.ai.reasoningEffort }), lifeWriter: resolveReplyWriter(replySettings, { model: localConfig.privateChatModel || localConfig.world?.model || state.ai.model, reasoningEffort: localConfig.privateChatReasoningEffort || state.ai.reasoningEffort }) } },
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
  return {
    ...state.maintenance,
    webLookup: { ...state.maintenance.webLookup, effectiveProvider: webSearchProvider,
      retrieval: chatRetrieval.getStatus(), publicCatalog: publicTopicCatalog.getStatus() },
    video: { enabled: Boolean(videoReader), ...(videoReader?.getStatus() || {}) },
    privateReply: buildPublicState().ai.privateReply,
    codex: {
      ...state.maintenance.codex,
      pathExists: codexPathOk,
      quota
    },
    channels: {
      pwa: state.channels.pwa,
      imessage: state.channels.imessage
    },
    privateChat: {
      recentEvents: state.privateChat.events.length,
      webLookupEnabled: state.privateChat.webLookup.enabled,
      webLookupProvider: state.maintenance.webLookup.effectiveProvider || webSearchProvider
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

function formatPrivateIncomingPromptText(event, text) {
  if (text) return text;
  if (event.images?.length) return "对方发送了图片或表情，没有附文字。";
  if (Array.isArray(event.raw?.message) && event.raw.message.some(segment => ["face", "mface"].includes(segment?.type))) {
    return "对方发送了表情，没有附文字。";
  }
  if (event.hasReplySegment) return "对方引用了前面的消息，没有附文字。";
  if (event.hasSelfAtSegment) return "对方只 @ 了你，没有附加具体内容。";
  return "对方没有附文字，请结合当前消息及上下文回应。";
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function normalizePrivateDisplayText(text) {
  return String(text || "")
    .replace(/\[CQ:image,[^\]]+\]/g, "[图片]")
    .replace(/\[CQ:(?:record|voice|audio),[^\]]+\]/g, "[语音]")
    .replace(/\[CQ:face,[^\]]+\]/g, "[表情]")
    .replace(/\[CQ:reply,[^\]]+\]/g, "")
    .replace(/\[CQ:at,qq=\d+(?:,name=([^\]]+))?[^\]]*\]/g, (_, name) => name ? `@${name}` : "@对方")
    .replace(/\s+/g, " ")
    .trim();
}

function shouldRespondToPrivate(event) {
  return { ok: isPrivateMemoryEvent(event) && pwaIdentityCurrent(event, pwaStore) && pwaWritable(), reason: 'Invitation private chat' };
}







function buildAssistantReply(event) {
  const text = stripMentionText(event.text);
  const topic = text || "刚刚叫我但是没有给题目";
  const address = event.isOwner ? `${ownerLabel}，` : "";

  return `收到，${address}我看到啦：${topic}`;
}

function buildBoundaryReply(event) {
  const text = stripMentionText(event.text);
  if (isFilesystemProbe(text)) {
    return `这涉及本机文件和后台信息，普通聊天里不会读取或公开这些内容。`;
  }
  return null;
}

function buildPrivateCommandAction(event) {
  const command = String(event.text || '').trim();
  if (!command.startsWith('/') || !event.isOwner) return null;
  const modelMatch = command.match(/^\/?模型\s+(.+)$/i);
  if (modelMatch) {
    const model = modelMatch[1].trim();
    if (!/^[A-Za-z0-9._:-]+$/.test(model)) {
      return { reply: `这个模型名看起来不太对，我这边只接受字母、数字、点、横线、下划线和冒号。` };
    }
    state.ai.model = model;
    return {
      reply: `私聊模型已切换：${model}`,
      afterSend: saveSettings
    };
  }

  const effortMatch = command.match(/^\/?(?:智能等级|智能|思考强度)\s+(low|medium|high|xhigh|低|中|高|最高)$/i);
  if (effortMatch) {
    const effort = normalizeReasoningEffort(effortMatch[1]);
    state.ai.reasoningEffort = effort;
    return {
      reply: `私聊智能等级已切换：${effort}`,
      afterSend: saveSettings
    };
  }

  return null;
}

// Classification is pure: command handlers can mutate settings and must never
// be called just to decide whether a message needs ordinary-chat safeguards.
function isBackendPrivateCommand(event) {
  const text = String(event.text || '').trim();
  return isHubCommand(text) || /^\/(执行|执行完全访问|远程执行|确认|取消|技能|帮助|清空任务记忆)(?:\s|$)/.test(text)
    || /^\/模型\s+/.test(text) || /^\/(?:智能等级|智能|思考强度)\s+/.test(text);
}



function isFilesystemProbe(text) {
  const normalized = String(text || "").toLowerCase();
  const sensitiveTarget = /(根目录|家目录|主目录|后台目录|项目目录|当前目录|\/users|\/var|\/etc|\/tmp|\/private|\.codex|config|settings|token|密钥|密码|环境变量|日志|文件系统)/i;
  const probeVerb = /(有什么|有哪些|列一下|列出|看看|读取|读一下|发出来|截图|目录|文件|路径|里面)/i;
  return sensitiveTarget.test(normalized) && probeVerb.test(normalized);
}

async function buildAssistantInstructions(event) {
  const speaker = event.isOwner ? ownerLabel : event.senderLabel || '对方';
  const channelName = '知微手机 PWA';
  return [
    `你正在为 ${channelName} 私聊生成本轮将由知微账号发出的回复。`,
    '只输出最终要发送出去的中文文本，不要解释，不要写前后缀，不要使用 Markdown。',
    '你是接入' + channelName + '的 ' + assistantName + '。自称“我”，自然地与当前对象聊天。',
    '当前说话者：' + speaker + '。管理员使用普通语气时同样是日常聊天；只有显式斜杠命令进入管理交互，不主动展示指令菜单或测试提示。',
    '只有较长回复中各自完整、可独立阅读的语义段才用空行分开，系统会按空段依次发送；单换行仍在同一条内。短答保持一条，相互依赖的条件、解释和步骤放在一起；按意思分段，不为分段扩写或逐句加空行。本轮若要求只发一条，以该要求为准。',
    state.privateChat.enhancer.enabled ? buildChatStyleInstructions(event) : '',
    '不要机械复读对方的昵称。不要透露本机路径、凭据、后台连接方式或其他对象的私聊隐私。',
    '实际系统、文件和账号操作由已授权的显式命令处理；普通聊天不冒称已经执行，也不替代权限核验。',
    '收到引用时结合引用内容；收到实际视觉输入时结合图片回复，看不清就直说，不编造没有看到的细节。',
    '轻松聊天里情绪明确且本地表情贴切时，优先在自然文字后跟一张表情；没有贴切素材或当前不适合就只发文字，不要求每条都发。先写完整文字，最后单独一行 [[qq_sticker:完整文件名]]。只能选本地表情库真实存在的文件，每次最多一张，不连续复用同一张，不只输出标记，不为配图硬编话。',
    '优先依据本次提供的相关记忆、引用及上下文回答；信息不足就承认，不编造往事或假装读过外部材料。',
    '',
    ''
  ].filter(part => part != null).join('\n');
}

async function loadAssistantSkillBrief() {
  const text = await loadAssistantProfile({ projectDir, config: localConfig });
  if (!text) return '';
  return '以下为当前身份与交流起点，可随有依据的经历修订；本轮任务的输出格式、来源和可发送范围以上下文任务约定为准：\n' + text;
}

function cleanCodexReply(text) {
  return String(text || "")
    .replace(/^```(?:text|json)?/i, "")
    .replace(/```$/i, "")
    .trim()
    .replace(/^["']|["']$/g, "")
    .trim();
}

function throwIfReplySuperseded(event) {
  if (event.replyTurn?.signal.aborted) throw Object.assign(new Error('Reply superseded by newer input'), { code: 'REPLY_SUPERSEDED' });
}

function creativeKindsFor(event) {
  return pwaWritable() && !serviceLifecycle?.stopping && !event?.hubPreview && !event?.backendCommand
    && pwaIdentityCurrent(event, pwaStore, { generation: true })
    && pwaStore.getIdentity(event.privateIdentity.userId)?.preferredChannel === 'pwa'
    ? enabledCreativeKinds(pwaConfig.creativeTools) : [];
}

function programWebsiteReady() {
  if (pwaConfig.creativeTools?.programWebsite !== true || process.platform !== 'linux') return false;
  try {
    return statSync(process.env.ZHIWEI_CREATIVE_RUNNER_SOCKET || '/run/zhiwei-creative/program.sock').isSocket();
  } catch { return false; }
}

function currentRuntimeCapabilities({ event = null, entry = 'chat', stickersAvailable = null } = {}) {
  const readiness = world?.readiness();
  const identity = isPwaEvent(event) && pwaIdentityCurrent(event, pwaStore)
    ? pwaStore?.getIdentity(event.privateIdentity.userId) : null;
  const activePwa = Boolean(identity?.enabled && identity.bindingStatus === 'active' && identity.preferredChannel === 'pwa');
  const writable = Boolean(pwaStore && pwaMedia && pwaWritable() && !serviceLifecycle?.stopping);
  const ordinary = ['chat', 'busy'].includes(entry);
  const creativeKinds = ordinary || entry === 'proactive' ? creativeKindsFor(event) : [];
  return buildRuntimeCapabilities({
    worldEnabled: Boolean(world && readiness?.enabled),
    browsingReady: ['reading', 'planner'].includes(entry) ? null : Boolean(world && readiness?.enabled && !readiness.busy && !readiness.browser?.busy && readiness.browser?.mode !== 'login'),
    autonomousBrowsing: browseIntentsAvailable(), browseIntentAvailable: ordinary && browseIntentsAvailable(),
    platforms: localConfig.world?.xBrowser ? ['web', 'x', 'xiaohongshu'] : ['web', 'xiaohongshu'],
    accounts: world?.accountFacts?.() || {},
    chatLookupEnabled: state.privateChat.webLookup?.enabled === true,
    nativeSearchEnabled: false,
    lifeEnabled: lifeAvailable(), memoryEnabled: typeof unifiedMemory.captureEpoch === 'function',
    proactiveContactEnabled: Boolean(lifeAvailable() && lifeProactive && !serviceLifecycle?.stopping
      && (!event || isLifeContactEligible(event) && !lifeContacts?.isPaused(memoryScope(event)))),
    stickersAvailable, stickerReplyAvailable: stickersAvailable === true && entry === 'chat' && !event?.lifeResumeContext,
    video: { enabled: localConfig.video?.enabled === true, engineReady: Boolean(videoReader), platforms: videoReader?.platforms,
      turnAvailable: ordinary && activePwa && writable && !event?.hubPreview, evidence: event ? videoTurnFacts.get(event) : undefined },
    pwa: { enabled: Boolean(pwaStore), writable, currentConversation: activePwa,
      creativeKinds, programWebsite: creativeKinds.includes('website') && programWebsiteReady(),
      space: pwaConfig.spaceEnabled === true && Boolean(pwaStore),
      spaceReplies: pwaConfig.spaceEnabled === true && lifeAvailable() && Boolean(spaceCommentReplies),
      thoughtReview: ordinary && activePwa && lifeAvailable() && Boolean(privateThoughtActions),
      images: Boolean(pwaMedia && privateVisionAvailable), references: Boolean(pwaStore), history: Boolean(pwaStore),
      legacyHistory: Boolean(activePwa && /^qq:private:\d+$/.test(identity.memoryScope) && typeof unifiedMemory.readLegacyHistory === 'function'),
      legacyReferences: Boolean(activePwa && pwaHistory && /^qq:private:\d+$/.test(identity.memoryScope)),
      historySearch: Boolean(pwaHistory), stickerPicker: Boolean(pwaStickers),
      notificationServiceEnabled: Boolean(writable && pwaPush && pwaConfig.pushEnabled !== false),
      notificationRecipientEligible: event ? activePwa ? pwaStore.notificationEligibility(identity.userId) : false : null }
  });
}

function currentCapabilityText(event, { entry = 'chat', stickersAvailable = null } = {}) {
  return renderRuntimeCapabilities(currentRuntimeCapabilities({ event, entry, stickersAvailable }), { entry });
}

async function buildModelReply(event) {
  const temporary = createTransientFiles();
  try { return await buildModelReplyWithFiles(event, temporary); }
  finally {
    await event.videoEvidenceRelease?.(); event.videoEvidenceRelease = null;
    void backgroundTask(temporary.finish()).then(result => { if (!result.ok) console.error('Could not remove completed reply temporary files'); });
  }
}

function creativeBinding(event, taskKey, epochToken = event.memoryEpochToken, personaToken = event.personaToken) {
  const identity = event.privateIdentity;
  return { userId: identity.userId, scope: identity.memoryScope, routeVersion: identity.routeVersion,
    generation: identity.generation, taskKey,
    contextKey: createHash('sha256').update(JSON.stringify([epochToken?.epoch, personaToken?.identity])).digest('hex') };
}

async function makePrivateWork(event, binding, proposal, assertReplyCurrent) {
  const caller = resolveReplyWriter(replySettings, { model: localConfig.privateChatModel || state.ai.model,
    reasoningEffort: localConfig.privateChatReasoningEffort || state.ai.reasoningEffort });
  const assertCurrent = async () => {
    await assertReplyCurrent();
    if (!creativeKindsFor(event).includes(proposal.kind)) {
      throw Object.assign(Error('Creative work no longer current'), { code: 'REPLY_SUPERSEDED' });
    }
  };
  event.creativeBinding = binding;
  const result = await withCurrentReplySignal(assertCurrent, async ({ signal, assertCurrent: current }) => {
    const model = async (purpose, field, prompt, maxLength, imagePaths = []) => {
      const schema = { type: 'object', additionalProperties: false, required: [field],
        properties: { [field]: { type: 'string', maxLength } } };
      const runner = createWorldModel({ ...caller, model: caller.model === 'default' ? undefined : caller.model,
        directory: join(projectDir, 'runtime', 'creative-model'), schema, proxy: localConfig.codexProxy, timeoutMs: 180000 });
      const answer = await backgroundTask(runtimeBudget.run({ purpose }, () => measureModelCall(async () => {
        await current(); return runner({ prompt, signal, imagePaths });
      })));
      await current();
      const value = JSON.parse(answer.text)?.[field];
      if (typeof value !== 'string' || !value.length || value.length > maxLength) throw Error('Invalid creative model response');
      return value;
    };
    const programWebsite = proposal.kind === 'website' && programWebsiteReady();
    return prepareCreativeWork({ store: pwaStore, binding, proposal, signal, assertCurrent: current,
      draft: async work => {
        const guidance = creativeSpecGuidance(work.kind, { programWebsite });
        const spec = await model('creative-' + work.kind + '-draft', 'specJson', [
          '你正在为刚才自己决定做的作品完成实际设计。按格式提供能交付的完整内容，使用自然中文或委托要求的文字。',
          guidance, '只返回一个JSON对象，其 specJson 字段是该作品规格对象序列化后的JSON字符串。',
          '你为这件作品写的题名与要求：' + JSON.stringify({ title: work.title, brief: work.brief })
        ].join('\n\n'), programWebsite ? 50000 : 24000);
        return JSON.parse(spec);
      },
      render: async work => {
        const run = async () => {
          await current();
          return renderCreativeWork(work, { model: caller.model === 'default' ? undefined : caller.model, codexPath: codexCliPath,
            proxy: localConfig.codexProxy, signal, brief: proposal.brief, programModel: programWebsite
              ? async ({ purpose, prompt, imagePaths }) => JSON.parse(await model(purpose, 'reviewJson', prompt, 50000, imagePaths))
              : undefined });
        };
        return work.kind === 'drawing'
          ? backgroundTask(runtimeBudget.run({ purpose: 'creative-drawing' }, () => measureModelCall(run))) : run();
      },
      describe: async receipt => model('creative-receipt', 'text', [
        '你是知微。你已经发起创作，下面是制作器的实际回执。用一句自然中文向同一位朋友说明结果，只输出含 text 的JSON。',
        'ready 表示作品已经生成，系统随你的这条消息附上私有作品卡，可预览和下载。failed 表示没有可交付的文件，running 表示制作尚未结束。依据回执说话，不编造文件、网址、发布状态或未查验的细节。',
        JSON.stringify(receipt)
      ].join('\n'), 320)
    });
  });
  event.creativeWorkId = result.workId;
  return result.text;
}

function discardCancelledWork(event, reason) {
  if (!event.creativeBinding || serviceLifecycle?.stopping || ![
    'reply-superseded', 'new-input-accepted', 'pwa-route-or-input-changed', 'delivery-stale',
    'contact-stopped-or-stale', 'contact-epoch-superseded', 'memory-epoch-changed', 'persona-revision-changed',
    'life-choice-replaced', 'life-choice-expired', 'note-source-changed', 'learned-source-changed',
    'retrieval-evidence-expired', 'retrieval-evidence-changed', 'video-evidence-expired', 'video-evidence-changed'
  ].includes(reason)) return;
  pwaStore.discardCreativeTask(event.creativeBinding);
  event.creativeBinding = null;
  event.creativeWorkId = null;
}

async function buildModelReplyWithFiles(event, temporary) {
  throwIfReplySuperseded(event);
  videoTurnFacts.delete(event);
  event.lifeBrowseIntent = null;
  event.creativeWorkId = null;
  event.creativeBinding = null;
  event.privateThought = null;
  event.chatEvidenceValidity = null;
  event.videoEvidenceValidity = null;
  event.retrievalFallbackText = null;
  event.personaToken = personaPolicy?.capture();
  const assertMemoryCurrent = async () => {
    personaPolicy?.assertCurrent(event.personaToken);
    if (event.learningValidity && !await event.learningValidity()) throw Error('Learned source changed');
    if (!await pwaEventHistoryCurrent(event)) throw Object.assign(Error('History source changed'), { code: 'HISTORY_SOURCE_CHANGED' });
    if (event.hubPreview === true) { personaPolicy?.assertCurrent(event.personaToken); return; }
    if (!await unifiedMemory.isEpochCurrent(event.memoryEpochToken)) {
      throw Object.assign(Error('Private memory epoch changed'), { code: 'MEMORY_EPOCH_CHANGED' });
    }
    personaPolicy?.assertCurrent(event.personaToken);
  };
  await assertMemoryCurrent();
  if (!isPrivateMemoryEvent(event)) throw Error('Private chat requires a valid participant');
  const text = stripMentionText(event.text);
  const mood = await moodState.prepare(event).catch(() => ({ context: '' }));
  const id = crypto.randomUUID();
  const outputPath = temporary.add(join(codexTmpDir, `${id}.txt`));
  const structuredLifeReply = Boolean(!event.hubPreview && localConfig.life?.enabled && lifeContacts && event.lifeContactToken);
  const structuredRetrievalReply = state.privateChat.webLookup.enabled === true;
  const allowPrivateThought = Boolean(pwaConfig.privateThoughtsEnabled === true && pwaWritable()
    && !event.hubPreview && !event.backendCommand && event.memoryEpochToken?.scope === memoryScope(event)
    && pwaIdentityCurrent(event, pwaStore));
  const creativeKinds = creativeKindsFor(event);
  const creativeReplyOptions = { allowReceiptOnly: creativeKinds.includes('website') && programWebsiteReady() };
  const structuredLocalReply = structuredLifeReply || allowPrivateThought || creativeKinds.length > 0;
  const boundaryEvidence = event.lifeContactEvidence;
  const quotedContext = formatQuotedContext(event);
  let rawHistoryContext = '';
  const rawHistoryAvailable = isPwaEvent(event) && Boolean(pwaHistory) && (structuredRetrievalReply || replySettings.mode !== 'two-stage');
  let webContext = '';
  const stickerCatalog = state.privateChat.enhancer.enabled ? await buildStickerCatalog(stickerDir) : [];
  const recallOptions = { scope: memoryScope(event),
    query: [text, event.replyContext?.scopeVerified ? event.replyContext.text : ''].filter(Boolean).join('\n'),
    replyMessageId: event.replyMessageId, limit: 8, includeRecent: true };
  let recalled = await unifiedMemory.recall(recallOptions);
  // The application approves outbound public topics; private context remains local.
  let publicTopics = []; 
  const combinedLifeReply = Boolean(event.lifeResumeContext);
  let memoryUsed = combinedLifeReply, historyUsed = false, lookupUsed = false, generation = 0;
  let followingPage = false;
  const webResults = [];
  const allowRawHistory = () => !followingPage && rawHistoryAvailable && !historyUsed && (!memoryUsed || combinedLifeReply) && generation < 2;
  const decisionOptions = () => ({
    allowMemoryMore: !memoryUsed && !followingPage && generation < 2,
    allowLookup: ((!lookupUsed && generation < 2) || followingPage) && !event.hubPreview && publicTopics.length > 0,
    allowBrowseIntent: structuredLifeReply && browseIntentsAvailable(), allowPrivateThought, creativeKinds, topics: publicTopics
  });
  const assertReplyCurrent = async () => {
    throwIfReplySuperseded(event);
    if ((structuredRetrievalReply || videoReader) && serviceLifecycle?.stopping) {
      throw Object.assign(Error('Reply stopped with service'), { code: 'REPLY_SUPERSEDED' });
    }
    await assertMemoryCurrent();
    if (event.chatEvidenceValidity) await event.chatEvidenceValidity();
    if (event.videoEvidenceValidity) await event.videoEvidenceValidity();
    if ((allowPrivateThought && !pwaIdentityCurrent(event, pwaStore))
      || (creativeKinds.length && !creativeKindsFor(event).length)) {
      throw Object.assign(Error('Private thought binding changed'), { code: 'REPLY_SUPERSEDED' });
    }
    if (!event.hubPreview && event.lifeContactToken && !isCurrentLifeReply(event)) {
      throw Object.assign(Error('Private reply no longer current'), { code: 'REPLY_SUPERSEDED' });
    }
  };
  const workBinding = creativeKinds.length ? creativeBinding(event, privateLogicalReplyId(event, 'exchange')) : null;
  if (workBinding) {
    const saved = pwaStore.getCreativeTask(workBinding);
    if (saved && creativeKinds.includes(saved.proposal.kind) && saved.proposal.brief
      && ['running', 'ready'].includes(saved.status)) {
      await assertReplyCurrent();
      const text = await makePrivateWork(event, workBinding, saved.proposal, assertReplyCurrent);
      event.learningModelReply = true;
      return text;
    }
  }
  publicTopics = structuredRetrievalReply ? await prepareChatPublicTopics({
    text: [text, quotedContext, recalled.context].filter(Boolean).join('\n'), explicitText: text,
    signal: event.replyTurn?.signal, assertCurrent: assertReplyCurrent }) : [];
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
  const imageTurn = selectPwaImageTurn(pwaStore, event, text);
  const imagePaths = [], readable = [], missing = [];
  if (imageTurn.selected.length) {
    const outputDir = temporary.add(join(projectDir, 'tmp', 'private-images', id), { directory: true });
    for (const item of imageTurn.selected) {
      await assertReplyCurrent();
      try {
        const [path] = await pwaMedia.prepareModelImages({ userId: event.privateIdentity.userId, mediaIds: [item.id], outputDir });
        imagePaths.push(path); readable.push(item);
      } catch (error) {
        if (!['ENOENT','ENOTDIR','media-unavailable','media-integrity'].includes(error.code) && error.status !== 404) throw error;
        missing.push(item);
      }
    }
  }
  event.pwaImageCursor = imageTurn.cursor;
  const userImageCount = imagePaths.length;
  let videoContext = '';
  let attachedFrames = [];
  // Only a currently shared or authorized quoted link can select a source.
  // A bare follow-up never searches memory for a URL or silently changes video.
  let videoSource = null;
  if (videoReader && !event.hubPreview && isPwaEvent(event)) {
    const resolveSource = async id => {
      const row = await pwaHistory.resolve(event.privateIdentity.userId, id);
      return { id: row.id, text: row.text, fingerprint: pwaHistoryFingerprint(row) };
    };
    const currentSources = [], quotedSources = [];
    for (const id of privateInboundIds(event)) currentSources.push(await resolveSource(pwaMessageId(id)));
    for (const row of event.pwaHistoryRefs || []) quotedSources.push(await resolveSource(row.id));
    videoSource = await videoSources.select({ scope: { kind: 'private', contactId: memoryScope(event), memoryEpoch: event.memoryEpochToken?.epoch },
      text, currentSources, quotedSources, resolveSource, assertCurrent: assertReplyCurrent });
    if (videoSource) event.pwaHistoryRefs = [...(event.pwaHistoryRefs || []).filter(row => row.id !== videoSource.sourceRef),
      { id: videoSource.sourceRef, fingerprint: videoSource.sourceFingerprint }];
  } else if (parseSharedVideoLinks(text)[0] || event.replyContext?.scopeVerified && parseSharedVideoLinks(event.replyContext.text)[0]) {
    videoContext = '当前视频取材未启用，本轮没有取得链接中的字幕或画面；可以回应可见文字，不能声称看过视频。';
  }
  if (videoSource && videoReader && !event.hubPreview) {
    await assertReplyCurrent();
    const result = await videoReader.read({ url: videoSource.url, atSeconds: videoSource.atSeconds ?? null,
      scope: { kind: 'private', contactId: memoryScope(event), memoryEpoch: event.memoryEpochToken?.epoch },
      signal: event.replyTurn?.signal, assertCurrent: assertReplyCurrent });
    event.videoEvidenceRelease = result.release;
    await assertReplyCurrent();
    videoTurnFacts.set(event, { status: result.status, subtitleCount: result.subtitles?.length || 0, frameCount: result.frames.length });
    if (['ok', 'partial'].includes(result.status)) {
      event.videoEvidenceValidity = () => videoReader.assertResultCurrent(result);
      attachedFrames = result.frames;
      imagePaths.push(...attachedFrames.map(frame => frame.path));
    }
    videoContext = formatVideoEvidence(result);
  } else if (videoSource) {
    videoContext = '当前视频取材未启用，本轮没有取得链接中的字幕或画面；可以回应可见文字，不能声称看过视频。';
  }
  const imageContext = describePwaImageTurn(imageTurn, readable, missing, {
    frames: attachedFrames, quotes: event.pwaReplyContexts, referenceUnavailable: Boolean(event.replyContextError)
  });
  event.imagePaths = imagePaths;
  const buildReplyPrompt = async (memoryBlock, expandLevel = 0, forceLocalReply = false) => {
    event.learningSelectionCommit = undefined;
    event.learningSelectionMaterial = undefined;
    event.learningValidity = undefined;
    let noteQuery = [text, event.replyContext?.scopeVerified ? event.replyContext.text : ''].filter(Boolean).join('\n');
    if (!queryTokens(noteQuery).length) noteQuery = /之前|那个|这个|继续|上次|刚才/.test(text) ? memoryBlock : '';
    const asksReadingHistory = /(?:刚才|之前|以前|最近|今天|上次|曾经).{0,12}(?:看|读|见闻|札记|笔记|内容)|(?:看过|读过|记过).{0,8}(?:什么|哪些)/.test(text);
    const remainingTopic = text.replace(/刚才|之前|以前|最近|今天|上次|曾经|看过|读过|记过|看的|读的|记的|看了|读了|札记|笔记|内容|见闻|有没有|有什么|怎么样|还记得|记得|东西/g, ' ');
    const recentNotes = asksReadingHistory && !queryTokens(remainingTopic).length;
    if (recentNotes) noteQuery = '';
    const notes = await recallReadingNotes({ scope: memoryScope(event), query: noteQuery,
      epochToken: event.memoryEpochToken, limit: 3, maxChars: 3600, recent: recentNotes, excludeText: memoryBlock });
    event.noteRefs = notes.sources.map(source => source.ref);
    const scope = memoryScope(event);
    const current = [formatPrivateIncomingPromptText(event, text), imageContext].filter(Boolean).join('\n');
    const profile = await loadAssistantSkillBrief();
    const learnedContext = event.learningConversation ? await privateLearning?.formatContext({ scope, userText: text, selectionKey: id,
      deferSelection: (commit, material) => { event.learningSelectionCommit = commit; event.learningSelectionMaterial = material; }, deferValidity: guard => { event.learningValidity = guard; },
      paused: lifeContacts?.isPaused(scope) === true }) || '' : '';
    const lifeContext = lifeAvailable() ? [lifeTimeline?.formatContext({ scope, excludeReading: true }), personalLifeState?.formatContext({ scope }), lifeConversation?.formatContext({ scope })].filter(Boolean).join('\n') : '';
    const recent = recalled.entries.filter(entry => entry.reason === 'recent' || /近期原文|近期互动背景/.test(entry.summary || ''))
      .map(entry => entry.summary).join('\n\n');
    const privateThoughts = allowPrivateThought ? pwaStore.listPrivateThoughts({
      userId: event.privateIdentity.userId, scope, epoch: event.memoryEpochToken.epoch, limit: 4
    }) : [];
    const evidence = createPrivateChatEvidence([
      { kind: 'current', text: current, scope },
      ...[ ['memory', [memoryBlock, rawHistoryContext].filter(Boolean).join('\n\n')], ['quote', quotedContext], ['notes', notes.text], ['desktop', desktopContext], ['web', webContext], ['video', videoContext], ['experience', learnedContext], ['relationship', privateProfileContext], ['life', lifeContext], ['mood', mood.context] ]
        .filter(([, value]) => value).map(([kind, text]) => ({ kind, text, scope }))
    ], privateThoughts, { scope });
    event.privateReplyContext = { mode: structuredLocalReply ? 'life' : 'raw', scope, evidence, profile, current, recent,
      turnId: id, plainText: Boolean(event.lifeResumeContext), stickerNames: stickerCatalog.map(item => item.name),
      allowContextMore: !forceLocalReply, allowBrowseIntent: browseIntentsAvailable(), allowPrivateThought, creativeKinds, maxChars: 900 };
    const contracts = [
    event.privateReplyContext.runtimeCapabilities = currentCapabilityText(event, { entry: event.lifeResumeContext ? 'busy' : 'chat', stickersAvailable: stickerCatalog.length > 0 }),
    await buildAssistantInstructions(event),
    !structuredRetrievalReply && allowRawHistory() ? pwaHistoryInstruction : '',
    rawHistoryAvailable && !allowRawHistory() ? '本轮不能再查聊天原文，基于实际材料回复，不再输出 pwa_history 内部标记。' : '',
    lifeAvailable() ? lifeTimeline?.formatContext({ scope: memoryScope(event), excludeReading: true }) || '' : '',
    lifeAvailable() ? personalLifeState?.formatContext({ scope: memoryScope(event) }) || '' : '',
    lifeAvailable() ? lifeConversation?.formatContext({ scope: memoryScope(event) }) || '' : '',
    event.lifeResumeContext || '',
    missing.length ? '部分或全部图片原件当前不可用；只根据本次实际提供的视觉输入回答。' : null,
    imageTurn.selected.length && !userImageCount ? '用户图片缓存读取失败，本轮没有这些图片的视觉输入；请明确说明看不到，不根据文件名或占位文字猜测内容。' : null,
    !privateVisionAvailable ? '当前没有图片或动画表情视觉输入。上下文里的图片占位、文件名、表情编号和链接不是图片内容；严禁据此编造人物、动作、情绪或梗。遇到带图消息只回应可读文字，被问图中内容时说明看不到。' : null,
    mood.context,
    privateProfileContext,
    '当前明确要求、事实更正和眼前情绪优先于旧交流经验。经验只适用于当前对象，可不用，不改变事实、关系、权限和停扰边界。',
    skillContext(installedSkills, resolveChatSkill(installedSkills, privateTasks.chatSkill(event) ?? localConfig.chatSkill)),
    "",
    memoryBlock ? "" : null,
    quotedContext ? "" : null,
    event.replyContextError ? '被引用的消息无法读取或无法核验属于当前私聊；不要猜测引用内容，需要时请对方提供原文。' : null,
    webContext ? "" : null,
    !structuredRetrievalReply && !structuredLocalReply && !forceLocalReply && expandLevel === 0 ? "如果这条消息明显是在追问前文、接上一句、问刚刚发生了什么，而你拿到的最近上下文仍然不够判断，请不要硬猜，直接只输出 [[qq_context_more]] 这个标记，让 Hub 继续向前翻记录后再回答。" : null,
    expandLevel === 0 ? "" : null,
    hasAnyPrivateImageReference(event) && !userImageCount ? "本条私聊消息或引用消息带了图片，但本轮没有可用的视觉输入。不要声称看过图片内容。" : null,
    imagePaths.length ? `可查看的本地图片数量：${imagePaths.length}` : null,
    imagePaths.length ? "请结合图片内容回复。不要过度保守：只要能看清主元素、文字、构图或梗图大意，就先说你看到了什么并给出判断；只有完全无法辨认主体时才说看不清。" : null,
    hasAnyPrivateImageReference(event) ? "" : null,
    state.privateChat.enhancer.enabled ? "本地表情包库：" : null,
    state.privateChat.enhancer.enabled ? formatStickerCatalog(stickerCatalog) : null,
    state.privateChat.enhancer.enabled && stickerCatalog.length ? "表情包库可用时，部署者可以在自定义 profile中说明何时使用 [[qq_sticker:表情包名]]；只能选择提示里真实存在的表情包名。" : null,
    "",
    "",
    forceLocalReply && !structuredRetrievalReply ? "不要再请求更多上下文，也不要输出任何内部标记。请基于当前消息、引用、图片和已经给到的上下文回复；如果仍缺少必要前文，直接说明没接上并请对方澄清，不要猜测。" : null,
    forceLocalReply ? "" : null,
    "请给出本轮最终回复，任务需要的事实、否定、条件、代码和数字完整保留。",
    structuredRetrievalReply ? chatReplyDecisionPrompt(boundaryEvidence?.event?.text, decisionOptions()) :
    structuredLocalReply ? lifeChatDecisionPrompt(boundaryEvidence?.event?.text, {
      allowContextMore: !forceLocalReply, allowBrowseIntent: browseIntentsAvailable(), allowPrivateThought }) : null,
    creativeDecisionPrompt(creativeKinds, creativeReplyOptions),
    structuredRetrievalReply && allowRawHistory() ? pwaHistoryInstruction.replace('结构化回复时将此标记放入 reply，contextMore 置 false。', '这是上文不输出动作标记规则的唯一例外：原文查询时 action=reply，reply 只含此标记，lookup=null，contactBoundary={kind:"none",quote:""}，browseIntent=null；不会发送这份中间结果。') : null,
    !structuredRetrievalReply && combinedLifeReply && allowRawHistory() ? '忙后合并补答允许这一次聊天原文查询，其余补查标记不用；取得结果后只给一条简短文字。' : null
    ].filter((part) => part != null);
    return buildLayeredReplyPrompt({ identity: profile, current, evidence, scope, contracts });
  };

  await ensureCodexReplyWorkspace();
  const schemaPath = temporary.add(join(codexTmpDir, `${id}.schema.json`));
  if (structuredRetrievalReply || structuredLocalReply) await writeFile(schemaPath,
    JSON.stringify(withCreativeSchema(withPrivateThoughtSchema(structuredRetrievalReply ? chatReplyDecisionSchema : lifeChatDecisionSchema, { allowPrivateThought }), creativeKinds)));

  const replyCaller = {
    model: event.type === 'private_message' ? (localConfig.privateChatModel || state.ai.model) : state.ai.model,
    reasoningEffort: event.type === 'private_message' ? (localConfig.privateChatReasoningEffort || state.ai.reasoningEffort) : state.ai.reasoningEffort
  };
  const replyRoute = event.type === 'private_message' && replySettings.mode === 'single'
    ? resolveReplyWriter(replySettings, replyCaller) : replyCaller;
  const args = [
    "exec",
    "--ephemeral",
    "--ignore-user-config",
    "--skip-git-repo-check",
    "--ignore-rules",
    "-s",
    "read-only",
    "-m",
    replyRoute.model,
    "-c",
    `model_reasoning_effort="${replyRoute.reasoningEffort}"`,
    ...(event.type === 'private_message' ? ['-c', 'web_search="disabled"'] : []),
    "-C",
    codexWorkspaceDir,
    "-o",
    outputPath,
    ...(structuredRetrievalReply || structuredLocalReply ? ['--output-schema', schemaPath] : []),
    ...imagePaths.flatMap((imagePath) => ["--image", imagePath]),
    "-"
  ];

  let lifeDecision;
  let baseReply = '', nextPurpose = combinedLifeReply ? 'qq-life-reply' : 'qq-chat';
  // The initial reply call decides whether it needs evidence. Each action has
  // one allowance, plus one optional link from the first observed article.
  for (generation = 0; generation < 3 + (webResults.length > 1 ? 1 : 0); generation++) {
    const options = decisionOptions();
    const forceLocal = structuredRetrievalReply ? !options.allowMemoryMore && !options.allowLookup : memoryUsed;
    let action = 'reply', historyRequest = null;
    try {
      const prompt = await buildReplyPrompt(recalled.context, memoryUsed ? 1 : 0, forceLocal);
      await assertReplyCurrent();
      const generate = structuredRetrievalReply ? generateControlledChatReply : generatePrivateReply;
      const cliResult = await generate(args, prompt, {
        budgetPurpose: nextPurpose, temporary, beforeRun: assertReplyCurrent,
        earlyReply: true, signal: event.replyTurn?.signal, cwd: codexWorkspaceDir,
        timeout: 300000, env: { ...process.env, CODEX_REMOTE_CONTACT_PRIVATE_MODE: '1' }
      }, event);
      await assertReplyCurrent();
      const raw = cliResult.replyText || await readFile(outputPath, 'utf8');
      if (structuredRetrievalReply) {
        try {
          lifeDecision = readCreativeDecision(raw, creativeKinds, value => parseChatReplyDecision(value, options), creativeReplyOptions);
          if (!structuredLifeReply && lifeDecision.contactBoundary.kind !== 'none') throw Error('No boundary evidence');
          action = lifeDecision.action;
          baseReply = lifeDecision.reply;
        } catch {
          // Never send malformed JSON or an intermediate draft, nor fall back
          // to the retired raw-message search/CLI tool path.
          lifeDecision = null;
          baseReply = '这次没能确认需要的资料，你能把想问的具体事情说清楚些吗？';
          event.skipExchangeMemory = true;
          break;
        }
      } else {
        if (structuredLocalReply) {
          lifeDecision = readCreativeDecision(raw, creativeKinds, value => parseLifeChatDecision(value, { allowPrivateThought }), creativeReplyOptions);
          if (!structuredLifeReply && lifeDecision.contactBoundary.kind !== 'none') throw Error('No boundary evidence');
          baseReply = lifeDecision.contextMore ? '[[qq_context_more]]' : lifeDecision.reply;
        } else baseReply = cleanCodexReply(raw);
        if (!memoryUsed && shouldRequestExpandedPrivateContext(stripMoodMarkers(baseReply))) action = 'memory_more';
      }
      historyRequest = parsePwaHistoryRequest(stripMoodMarkers(baseReply));
      if (historyRequest) {
        if (!allowRawHistory() || historyRequest.invalid || action !== 'reply'
          || lifeDecision?.contactBoundary?.kind && lifeDecision.contactBoundary.kind !== 'none'
          || lifeDecision?.browseIntent || lifeDecision?.privateThought) throw Error('Invalid history action');
        action = 'history_search';
      }
    } catch (caught) {
      if (['RETRIEVAL_EVIDENCE_EXPIRED', 'VIDEO_EVIDENCE_EXPIRED'].includes(caught.code)) {
        event.chatEvidenceValidity = null;
        event.videoEvidenceValidity = null;
        lifeDecision = null;
        baseReply = caught.code === 'VIDEO_EVIDENCE_EXPIRED' ? '刚才取得的视频资料已经过时，这次先不据此作答。' : '刚才查到的资料已经过时，这次先不据此作答。';
        event.skipExchangeMemory = true;
        event.learningSelectionMaterial = undefined;
        event.learningSelectionCommit = undefined;
        break;
      }
      if (generation === 0 || ['REPLY_SUPERSEDED','MEMORY_EPOCH_CHANGED','HISTORY_SOURCE_CHANGED'].includes(caught.code)
        || event.replyTurn?.signal.aborted) throw caught;
      // A failed follow-up never promotes an action draft or provider error
      // into speech, memory or learning. Preserve the pre-existing bounded
      // clarification for history expansion, including budget rejection.
      lifeDecision = null;
      baseReply = nextPurpose === 'qq-context-expansion'
        ? '这次没能补查到前文，你指的是哪一段？'
        : '这次没能确认需要的资料，稍后再试吧。';
      event.skipExchangeMemory = true;
      break;
    }
    if (action === 'reply') break;
    const record = state.privateChat.events.find(record => record.event === event);
    if (action === 'memory_more' || action === 'history_search') {
      memoryUsed = true;
      historyUsed ||= action === 'history_search';
      if (record?.decision) record.decision.status = '补查上下文';
      try {
        await assertReplyCurrent();
        let expanded;
        if (action === 'history_search') {
          if (!pwaIdentityCurrent(event, pwaStore)) throw Error('History identity changed');
          const found = await pwaHistory.search(event.privateIdentity.userId, historyRequest);
          await assertReplyCurrent();
          rawHistoryContext = formatPwaHistoryEvidence(found, historyRequest);
          event.pwaHistoryRefs = [...(event.pwaHistoryRefs || []), ...(found.records || []).map(record => ({ id: record.id, fingerprint: pwaHistoryFingerprint(record) }))];
          expanded = { ...recalled, hasNewEvidence: true };
        } else expanded = await unifiedMemory.recall({ ...recallOptions, limit: 20, expanded: true, previous: recalled });
        await assertReplyCurrent();
        // Repeating the same context is not a successful history expansion.
        if (action !== 'history_search' && (!expanded.hasNewEvidence || expanded.context === recalled.context)) {
          baseReply = '这句的前文我没接上，你指的是哪一段？';
          event.skipExchangeMemory = true;
          break;
        }
        recalled = expanded;
        if (structuredRetrievalReply) publicTopics = await prepareChatPublicTopics({
          text: [text, quotedContext, recalled.context].filter(Boolean).join('\n'), explicitText: text,
          signal: event.replyTurn?.signal, assertCurrent: assertReplyCurrent });
        nextPurpose = 'qq-context-expansion';
      } catch (caught) {
        if (['REPLY_SUPERSEDED','MEMORY_EPOCH_CHANGED','HISTORY_SOURCE_CHANGED'].includes(caught.code) || event.replyTurn?.signal.aborted) throw caught;
        baseReply = '这次没能补查到前文，你指的是哪一段？';
        event.skipExchangeMemory = true;
        break;
      }
    } else if (action === 'lookup') {
      lookupUsed = true;
      if (record?.decision) record.decision.status = '查询公开资料';
      await assertReplyCurrent();
      const result = await retrieveChatEvidence({
        request: { version: 1, id: crypto.randomUUID(), turnId: id,
          scope: { kind: 'private', contactId: memoryScope(event), memoryEpoch: event.memoryEpochToken?.epoch },
          publicQuery: lifeDecision.lookup },
        topics: publicTopics, signal: event.replyTurn?.signal, assertCurrent: assertReplyCurrent
      });
      await assertReplyCurrent();
      webResults.push(result);
      webContext = webResults.map(formatRetrievalEvidence).join('\n');
      event.chatEvidenceValidity = async () => { for (const evidence of webResults) await chatRetrieval.assertResultCurrent(evidence); };
      publicTopics = webResults.length === 1 ? await chatRetrieval.pageLinkTopics(result) : [];
      followingPage = publicTopics.length > 0;
      // Only aggregate, non-content diagnostics enter the event/observer.
      event.chatRetrieval = { status: result.status, cacheHit: result.cacheHit, metrics: result.metrics };
      state.maintenance.webLookup.lastQuery = null;
      state.maintenance.webLookup.lastRunAt = new Date().toISOString();
      state.maintenance.webLookup.lastOk = ['ok', 'partial'].includes(result.status);
      state.maintenance.webLookup.lastError = result.errorCode || null;
      state.maintenance.webLookup.lastDurationMs = result.metrics?.http?.durationMs ?? result.metrics?.durationMs ?? null;
      nextPurpose = 'qq-chat-lookup';
    }
  }
  throwIfReplySuperseded(event);
  await assertMemoryCurrent();
  if (!await readingNotesCurrent(event.noteRefs, { scope: memoryScope(event), epochToken: event.memoryEpochToken })) {
    throw Object.assign(Error('Reading note source changed'), { code: 'NOTE_SOURCE_CHANGED' });
  }
  if (shouldRequestExpandedPrivateContext(stripMoodMarkers(baseReply)) || parsePwaHistoryRequest(stripMoodMarkers(baseReply))) {
    baseReply = '这句的前文我没接上，你指的是哪一段？';
    event.skipExchangeMemory = true;
  }
  if (lifeDecision?.contactBoundary.kind !== 'none' && lifeDecision?.contactBoundary && boundaryEvidence) {
    const { kind, quote } = lifeDecision.contactBoundary;
    if (ownContactEvidence(boundaryEvidence.event).some(line => line.includes(quote))
      && (kind !== 'resume' || isExplicitContactInvitation(boundaryEvidence.event, quote))) {
      const applied = await unifiedMemory.withEpoch(event.memoryEpochToken, () => lifeContacts.applyDecision({ token: boundaryEvidence.token, event: boundaryEvidence.event,
        decision: { action: kind, basis: kind === 'pause' ? 'contextual-impatience' : 'explicit-invitation',
          evidence: quote, reason: kind === 'pause' ? 'same-turn-contextual-impatience' : 'same-turn-explicit-invitation' } }));
      if (applied?.reason === 'memory-epoch-changed') await assertMemoryCurrent();
    }
    if (kind === 'pause' && !lifeContacts.isCurrent(event.lifeContactToken)) return '';
  }
  if (structuredLifeReply && !isCurrentLifeReply(event)) return '';
  throwIfReplySuperseded(event);
  if (lifeDecision?.creativeWork && !event.skipExchangeMemory) {
    baseReply = await makePrivateWork(event, workBinding, lifeDecision.creativeWork, assertReplyCurrent);
  }
  if (!event.skipExchangeMemory && browseIntentsAvailable()) event.lifeBrowseIntent = lifeDecision?.browseIntent || null;
  baseReply = moodState.finalize(baseReply, event);
  const reply = state.privateChat.enhancer.enabled
    ? encourageStickerReply(
      baseReply,
      event,
      stickerCatalog
    )
    : baseReply;
  if (!reply) return buildAssistantReply(event);
  event.learningModelReply = !event.skipExchangeMemory;
  if (allowPrivateThought && event.learningModelReply && lifeDecision?.privateThought && reply.length <= 900) event.privateThought = lifeDecision.privateThought;
  if (replySettings.mode === 'two-stage' && stripMoodMarkers(reply).replace(/\[\[qq_sticker:[^\]]+\]\]/g, '').trim().length > 900) throw Error('Writer reply exceeds complete-text limit');
  return replySettings.mode === 'two-stage' ? reply : reply.slice(0, 900);
}


async function runReplyRole({ role, prompt, schema, caller, event, assertCurrent, imagePaths = [], deadline = Infinity }) {
  const route = role === 'writer' ? resolveReplyWriter(replySettings, caller) : caller;
  return backgroundTask(runtimeBudget.run({ purpose: `private-reply-${role}` }, () => measureModelCall(async () => {
    await assertCurrent();
    const remaining = Math.min(300000, deadline - Date.now());
    if (remaining < 100 || event?.replyTurn?.signal.aborted) throw Object.assign(Error('Reply expired'), { code: 'REPLY_SUPERSEDED' });
    const runner = createWorldModel({ directory: join(projectDir, 'runtime', `private-reply-${role}`),
      model: route.model === 'default' ? undefined : route.model, reasoningEffort: route.reasoningEffort,
      proxy: localConfig.codexProxy, schema, timeoutMs: remaining });
    const result = await runner({ prompt, imagePaths, signal: event?.replyTurn?.signal });
    try {
      await assertCurrent();
      if (Date.now() >= deadline) throw Object.assign(Error('Reply expired'), { code: 'REPLY_SUPERSEDED' });
      return result;
    } catch (error) { error.usage ??= result.usage ?? null; throw error; }
  })));
}

async function prepareChatPublicTopics({ text, explicitText = '', signal, assertCurrent }) {
  await assertCurrent();
  const catalog = publicTopicCatalog.peekTopics();
  if (signal?.aborted) throw Object.assign(Error('Reply superseded'), { code: 'REPLY_SUPERSEDED' });
  await assertCurrent();
  return approvePublicTopics({ text, explicitText, ...(catalog ? { catalog } : {}) });
}

async function retrieveChatEvidence(options) {
  // Refresh public vocabulary only as part of an actual lookup, and drain
  // both tasks even when a stale scope or cancellation makes one reject.
  const [retrieved] = await Promise.allSettled([
    chatRetrieval.retrieve(options), publicTopicCatalog.getTopics({ signal: options.signal })
  ]);
  await options.assertCurrent();
  if (retrieved.status === 'rejected') throw retrieved.reason;
  return retrieved.value;
}

// D-on uses the same tightly restricted model runner as read-only decisions.
async function generateControlledChatReply(_args, prompt, options, event) {
  const caller = { model: localConfig.privateChatModel || state.ai.model,
    reasoningEffort: localConfig.privateChatReasoningEffort || state.ai.reasoningEffort };
  const route = resolveReplyWriter(replySettings, caller);
  return backgroundTask(runtimeBudget.run({ purpose: options.budgetPurpose }, () => measureModelCall(() =>
    withCurrentReplySignal(options.beforeRun, async ({ signal, assertCurrent }) => {
    await assertCurrent();
    const runner = createWorldModel({ directory: join(projectDir, 'runtime', 'chat-decision-model'),
      model: route.model === 'default' ? undefined : route.model, reasoningEffort: route.reasoningEffort,
      proxy: localConfig.codexProxy, schema: withCreativeSchema(withPrivateThoughtSchema(chatReplyDecisionSchema, event.privateReplyContext), event.privateReplyContext.creativeKinds), timeoutMs: 300000 });
    const result = await runner({ prompt, imagePaths: event.imagePaths || [], signal });
    try { await assertCurrent(); return { replyText: result.text, usage: result.usage }; }
    catch (error) { error.usage ??= result.usage ?? null; throw error; }
  }))));
}

async function generatePrivateReply(args, prompt, options, event) {
  if (replySettings.mode !== 'two-stage') return runCodexCli(args, prompt, options);
  const context = event.privateReplyContext;
  const assertCurrent = async () => {
    throwIfReplySuperseded(event); personaPolicy?.assertCurrent(event.personaToken);
    await options.beforeRun?.();
    if (event.learningValidity && !await event.learningValidity()) throw Error('Learned source changed');
    if (!event.hubPreview && event.lifeContactToken && !isCurrentLifeReply(event)) throw Object.assign(Error('Reply superseded'), { code: 'REPLY_SUPERSEDED' });
    if (!await readingNotesCurrent(event.noteRefs, { scope: memoryScope(event), epochToken: event.memoryEpochToken })) throw Error('Reading source changed');
    throwIfReplySuperseded(event); personaPolicy?.assertCurrent(event.personaToken);
  };
  const caller = { model: localConfig.privateChatModel || state.ai.model,
    reasoningEffort: localConfig.privateChatReasoningEffort || state.ai.reasoningEffort };
  const result = await runReplyRole({ role: 'planner', prompt: prompt + '\n\n' + replyPlanPrompt(context) + (context.plainText ? '\n本轮是忙后纯文字补答，presentation两项必须为null；不再补查。' : ''),
    schema: replyPlanSchema(context), caller, event, assertCurrent, imagePaths: event.imagePaths });
  const plan = parseReplyPlan(result.text, context);
  let text = '';
  if (plan.utterance) {
    // A semantic plan and explicit local eligibility are both required. Missing
    // certainty leaves variations off; a retry reuses the logical turn seed.
    const variant = selectReplyVariant({ plan, entry: event.lifeResumeContext ? 'busy' : 'ordinary',
      turnId: context.turnId, seed: context.turnId, enabled: replySettings.styleProbability > 0,
      probability: replySettings.styleProbability, translationEnabled: replySettings.translationStyle,
      localContext: event.expressionEligibility || {
        command: event.backendCommand === true || /^\s*\//.test(event.text || ''),
        toolResult: Boolean(event.hubPreview || event.chatRetrieval || context.evidence.some(row => ['web', 'desktop'].includes(row.kind))),
        serious: plan.utterance.contextKind !== 'casual', distress: plan.utterance.contextKind !== 'casual',
        conflict: plan.utterance.contextKind !== 'casual', boundary: plan.control.contactBoundary?.kind !== 'none' && Boolean(plan.control.contactBoundary),
        playfulContext: false, sharedTranslationJoke: false
      } });
    event.replyStyleVariant = variant?.id || null;
    const writer = await runReplyRole({ role: 'writer', prompt: buildWriterPrompt({ ...context, plan, variant }),
      schema: writerReplySchema, caller, event, assertCurrent, imagePaths: event.imagePaths });
    text = parseWriterReply(writer.text, { maxChars: 900, requiredLiterals: plan.utterance.requiredLiterals }).text;
  }
  await assertCurrent();
  const assembled = assembleReply(plan, text, context);
  return { replyText: typeof assembled === 'string' ? assembled : JSON.stringify(assembled) };
}

function shouldRequestExpandedPrivateContext(reply) {
  return String(reply || "").includes("[[qq_context_more]]");
}

function encourageStickerReply(reply, event, stickerCatalog) {
  return ensureStickerLeadText(reply);
}

function hasAnyPrivateImageReference(event) {
  return (Array.isArray(event.images) && event.images.length > 0)
    || (Array.isArray(event.replyContext?.images) && event.replyContext.images.length > 0);
}

function isPrivateImageLookRequest(text) {
  return /(看图|看一下图|看看图|这图|这个图|这张|图片|截图|表情包|图里|图上|什么图|配图|识别|看得懂|看不懂|何意味|逆天|抽象|离谱|绷不住|典中典|味太冲|评价一下|锐评|说说|怎么看|看法)/i.test(String(text || ""));
}

function isPrivateMemoryEvent(event) {
  if (!isPwaEvent(event) || event.type !== 'private_message' || event.groupId != null || event.raw?.group_id != null) return false;
  try { return isPrivateScope(privateEventScope(event)); } catch { return false; }
}

async function rememberPrivateExchange(event, reply) {
  if (!isPrivateMemoryEvent(event) || !reply || event.skipExchangeMemory
    || event.backendCommand === true) return { ok: true, skipped: true, reason: 'not-conversation-memory' };
  const saved = await unifiedMemory.writeExchange({ scope: memoryScope(event),
    senderLabel: event.senderLabel || String(event.senderId),
    userText: stripMentionText(event.text || ''), replyText: String(reply),
    messageId: event.raw?.message_id, replyMessageId: event.replyMessageId,
    sentMessageIds: event.sentMessageIds || [],
    ...(isPwaEvent(event) ? { deliveryId: event.pwaLogicalReplyId, channel: 'pwa' } : {}),
    epochToken: event.memoryEpochToken,
    learningEligible: event.learningConversation === true && event.learningModelReply === true,
    quotedText: event.replyContext?.scopeVerified ? event.replyContext.text || '' : '' });
  if (saved?.ok && event.learningConversation && event.learningModelReply && (!isPwaEvent(event) || pwaWritable())) {
    // Scheduling is optional and must never turn a delivered reply into a failure.
    void Promise.resolve(privateLearning?.noteExchange({ scope: memoryScope(event) }))
      .catch(() => console.error('Could not schedule optional private learning'));
  }
  return saved;
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
      `网页：${state.channels.pwa ? "开启" : "关闭"}`,
      `默认模型：${state.ai.model} / ${state.ai.reasoningEffort}`,
      `iMessage：${state.channels.imessage ? "开启" : "关闭"}`,
      `iMessage 私聊模型：${state.ai.imessageModel} / ${state.ai.imessageReasoningEffort}`,

      `iMessage 记忆：${Object.keys(state.imessage.memory.entries).length} 个联系人`,
      `远程执行模式：${state.remoteExecution.enabled ? "开启" : "关闭"}`
    ].join("\n");
    return {
      ok: true,
      summary: `PWA=${state.channels.pwa ? "on" : "off"}, iMessage=${state.channels.imessage ? "on" : "off"}`,
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
      `Codex：${health.codex.pathExists ? "路径正常" : "路径缺失"}${health.codex.lastDurationMs != null ? `，上次 ${health.codex.lastDurationMs}ms` : ""}`,
      formatCodexQuotaSummary(health.codex.quota),
      `网页：${health.channels.pwa ? "开启" : "关闭"}，事件 ${health.privateChat.recentEvents} 条`,
      `iMessage：${health.channels.imessage ? "开启" : "关闭"}，${health.imessage.status}`,
      `代理：${formatProxyStatus(proxy)}`,
      `联网查询：${health.webLookup.enabled ? "开启" : "关闭"}${health.webLookup.lastDurationMs != null ? `，上次 ${health.webLookup.lastDurationMs}ms` : ""}`,
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
    state.privateChat.webLookup.enabled = true;
    state.maintenance.webLookup.enabled = true;
    return { ok: true, summary: "Private web lookup enabled", reply: "私聊联网查询已开启。" };
  }
  if (/^(联网关|关闭联网|关掉联网|联网查询关)$/.test(normalized)) {
    state.privateChat.webLookup.enabled = false;
    state.maintenance.webLookup.enabled = false;
    privateThoughtActions?.invalidate();
    return { ok: true, summary: "Private web lookup disabled", reply: "私聊联网查询已关闭。" };
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
  return { ok: false, summary: "Unknown command", reply: "没认出这个指令。可用：/状态、/额度、/刷新额度、/启动Codex、/前台Codex、/退出Codex、/维护、/记忆、/交接、/清除记忆、/代理状态、/代理开、/代理关、/联网开、/联网关、/休眠、/帮助。" };
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

async function clearMemoryWithContactEvidence(options = {}) {
  const scope = options.scope ?? 'owner';
  if (scope === 'all' || isPrivateScope(scope)) await lifeContacts?.forgetPauseEvidence(scope);
  return unifiedMemory.clear(options);
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
  await clearMemoryWithContactEvidence({ scope: "all" });
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
    "按当前内容自然决定篇幅；招呼和轻量互动可以只回一句，认真求助按需展开。",
    "如果提供了长期滚动上下文，请把它当作私聊记忆使用：能承接前文，但不要主动复读记忆内容。",
    "不要在结尾追加 AI 助手味很重的服务式结束语，例如“想的话我还能……”“如果需要我可以……”“要不要我再……”。",
    "不要执行电脑操作；只有以 / 开头的 iMessage 指令由 Hub 执行。普通私聊只回应文本。",
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
  if (event.pwaReplyContexts?.length) return event.pwaReplyContexts.map(context => formatQuotedContext({ ...event, pwaReplyContexts: null, replyContext: context })).join("\n\n");
  if (!event.replyContext) return "";
  const context = event.replyContext;
  const speaker = context.isSelf
    ? `${assistantName} 之前发出的消息`
    : context.senderName || '对方';
  const text = stripMentionText(context.text || "");
  const imageSummary = formatImageSummary(context.images || []);
  if (!text && !imageSummary && !context.quotedText) return "";
  const replyHint = context.isSelf
    ? (context.scopeVerified ? "这条消息引用了你在当前私聊发过的内容。"
      : "用户引用了你的消息；桥接未提供原接收对象，不能断言这是你对当前对象说过的话。")
    : "这条消息引用了下面这条上下文。";
  return [
    "被回复/引用的消息上下文：",
    replyHint,
    context.source ? `来源：${context.source === "qq" ? "旧QQ留存原文" : "网页消息"}；原时间：${context.createdAt || "未知"}。这是历史引用，不是当前新收到的发言。` : null,
    context.truncated ? "原文只保留了部分，缺失内容不可补造。" : null,
    context.mediaMissing ? "原消息图片未留存，本轮不可查看。" : null,
    `${speaker}：${text || (context.quotedText ? "（仅留存当时的引用）" : "（图片消息）")}`,
    context.quotedText ? `当时引用的原文（原说话方未记录，不当作当前对象自述）${context.quotedTruncated ? "，仅部分留存" : ""}：${context.quotedText}` : null,
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
  if (['qq-chat', 'qq-life-reply', 'qq-context-expansion'].includes(options.budgetPurpose)) {
    args = [...args]; args.splice(1, 0, '-c', 'project_doc_max_bytes=0');
  }
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
    if (options.signal?.aborted) throw Object.assign(new Error('Reply superseded by newer input'), { code: 'REPLY_SUPERSEDED' });
    if (localConfig.codexProxy) {
      try { await assertProxyReachable(localConfig.codexProxy); }
      catch (error) { error.safeForChat = true; throw error; }
    }
    if (options.signal?.aborted) throw Object.assign(new Error('Reply superseded by newer input'), { code: 'REPLY_SUPERSEDED' });
    await options.beforeRun?.();
    let exited = false, spawned = false, releaseTemporary = () => {};
    const noteExit = () => { if (!exited) { exited = true; activeCliProcesses--; releaseTemporary(); } };
    activeCliProcesses++;
    let result;
    try {
      result = await runCliProcess({ ...invocation, cwd: options.cwd, env: childEnv,
        input, timeout: options.timeout, earlyReply: Boolean(options.earlyReply), signal: options.signal, onExit: noteExit,
        onSpawn: () => { spawned = true; releaseTemporary = options.temporary?.retain() || (() => {}); } });
    } catch (error) { if (!spawned) noteExit(); throw error; }
    state.maintenance.codex.lastOk = true;
    state.maintenance.codex.lastError = null;
    void refreshCodexQuotaSnapshotAfterRun({ startedAtMs: startedAt, previousQuota }).catch(() => null);
    return result;
  } catch (caught) {
    // A replacement is normal turn scheduling. Keep its usage for the meter,
    // without publishing a CLI failure or retaining the discarded draft in logs.
    if (['REPLY_SUPERSEDED','MEMORY_EPOCH_CHANGED','HISTORY_SOURCE_CHANGED'].includes(caught.code)) throw caught;
    if (options.signal?.aborted) throw Object.assign(new Error('Reply superseded by newer input'), {
      code: 'REPLY_SUPERSEDED', usage: caught.usage || null, cliTiming: caught.cliTiming });
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
  // Reply instructions are supplied explicitly per turn. Do not generate a
  // second, stale AGENTS profile inside a runtime workspace.
}

function outboundLogicalId(scope, intentId) {
  return 'pwa-out-' + createHash('sha256').update(scope + ':' + intentId).digest('hex');
}

async function dispatchPrivateSegments(event, segments, outbound = null, textComplete = false) {
  if (!isPrivateMemoryEvent(event)) return { ok: false, reason: 'private-route-unavailable' };
  if (!pwaWritable()) return { ok: false, reason: 'pwa-read-only' };
  if (!pwaIdentityCurrent(event, pwaStore, { generation: true })) return { ok: false, reason: 'pwa-route-or-input-changed' };
  const scope = memoryScope(event), identity = event.privateIdentity;
  const kind = outbound?.kind || (event.pwaStatusReply || event.lifeStatusActivityId ? 'status' : event.backendCommand ? 'command' : 'exchange');
  event.pwaLogicalReplyId ||= outbound?.intentId
    ? outboundLogicalId(scope, outbound.intentId)
    : privateLogicalReplyId(event, kind);
  const logicalReplyId = event.pwaLogicalReplyId;
  pwaActiveLogical.add(logicalReplyId);
  const index = event.pwaSegmentIndex || 0;
  const text = segments.filter(segment => segment.type === 'text').map(segment => String(segment.data?.text || '')).join('');
  const converted = segments.filter(segment => segment.type === 'text' && String(segment.data?.text || '').length)
    .map(segment => ({ type: 'text', text: String(segment.data.text) }));
  if (segments.some(segment => segment.type === 'image')) converted.push(...await pwaMedia.publishOutboundMedia({
    userId: identity.userId, segments: segments.filter(segment => segment.type === 'image') }));
  if (event.creativeWorkId && text && (kind === 'exchange' && textComplete || kind === 'outbound')) {
    converted.splice(0, converted.length, { type: 'work', workId: event.creativeWorkId, text });
  }
  if (!converted.length) return { ok: false, reason: 'empty-private-delivery' };
  const evidenceFailure = await privateEvidenceFailure(event);
  if (evidenceFailure) return { ok: false, reason: evidenceFailure };
  if (!await pwaEventHistoryCurrent(event)) return { ok: false, reason: 'history-source-changed' };
  const replyText = [event.pwaDeliveredText || '', text].filter(Boolean).join('\n\n');
  const includePrivateThought = textComplete && kind === 'exchange' && event.learningModelReply === true
    && !event.skipExchangeMemory && !event.pwaSkipMemory && Boolean(replyText.trim());
  const includeImageCursor = kind === 'exchange' && textComplete && event.learningModelReply && !event.skipExchangeMemory && !event.pwaSkipMemory;
  const projection = { version: 1, kind, logicalReplyId, event: projectionEvent(event, { includePrivateThought }), replyText,
    skipMemory: event.pwaSkipMemory === true, mood: moodState.exportPending(event),
    selection: event.learningSelectionMaterial || null,
    ...(outbound ? { intentId: outbound.intentId, decisionId: outbound.decisionId,
      epochToken: outbound.epochToken } : {}) };
  try {
    const result = pwaStore.publishSegments({ userId: identity.userId, scope,
      routeVersion: identity.routeVersion, generation: identity.generation,
      inboundIds: kind === 'outbound' ? [] : privateInboundIds(event),
      imageCursor: includeImageCursor ? event.pwaImageCursor : null,
      deliveryId: `${logicalReplyId}:${index}`, logicalReplyId, segmentIndex: index, segments: converted,
      creativeContextKey: event.creativeBinding?.contextKey || '',
      projection, projectionKey: logicalReplyId, allowedPendingProjectionKey: logicalReplyId });
    event.pwaSegmentIndex = index + result.messages.length;
    event.pwaDeliveredText = replyText;
    event.sentMessageIds = [...new Set([...(event.sentMessageIds || []), ...result.messages.map(message => message.id)])];
    pwaHttp?.changed(identity.userId);
    return { ok: true, body: { data: { message_id: result.messages[0]?.id } },
      deliveryId: result.deliveryId, durable: true };
  } catch (error) {
    if (['delivery-stale', 'intake-pending', 'projection-pending', 'account-unavailable', 'binding-pending'].includes(error.code)) {
      return { ok: false, reason: error.code };
    }
    throw error;
  }
}

function completedPwaSink(result, name) {
  if (result?.ok === true) return result;
  if (result?.reason === 'memory-epoch-changed') return { ...result, ok: true, skipped: true };
  throw Object.assign(Error('PWA projection sink did not commit'), { code: `projection-${name}-incomplete` });
}

async function flushPwaProjections() {
  if (!pwaStore || pwaProjectionRunning) return;
  pwaProjectionRunning = true;
  try {
    for (const pending of pwaStore.listPendingProjections({ limit: 100 })) {
      if (pwaActiveLogical.has(pending.payload?.logicalReplyId)) continue;
      let job;
      try {
        job = pwaStore.claimProjection(pending.id);
        const material = job.payload;
        if (material?.version !== 1 || !material.event || !isPwaEvent(material.event)) throw Error('Unsupported PWA projection material');
        const event = { ...material.event, sentMessageIds: material.sentMessageIds || [] };
        const epochToken = material.epochToken || event.memoryEpochToken;
        const current = epochToken && await unifiedMemory.isEpochCurrent(epochToken);
        const results = {};
        // Each sink owns its idempotency/CAS inside its own durable write. A
        // newer input cannot discard an already-published conversation fact.
        if (current && !material.skipMemory && !['status', 'command'].includes(material.kind)) {
          if (material.selection) results.selection = completedPwaSink(await privateLearning?.commitSelectionProjection(material.selection), 'selection');
          if (material.mood) results.mood = completedPwaSink(await moodState.commitProjection(material.mood, material.logicalReplyId), 'mood');
          if (material.kind === 'outbound') {
            results.memory = await unifiedMemory.writeOutbound({ scope: job.scope, replyText: material.replyText,
              intentId: material.intentId, deliveryId: material.logicalReplyId, channel: 'pwa',
              learningEligible: true, epochToken, sentMessageIds: event.sentMessageIds });
            results.memory = completedPwaSink(results.memory, 'memory');
            if (!results.memory.skipped && pwaWritable()) void Promise.resolve(privateLearning?.noteExchange({ scope: job.scope })).catch(() => {});
          } else {
            results.memory = completedPwaSink(await rememberPrivateExchange(event, material.replyText), 'memory');
            if (event.privateThought && !results.memory.skipped && material.kind === 'exchange') {
              results.privateThought = completedPwaSink(await unifiedMemory.withEpoch(epochToken, () =>
                pwaStore.commitPrivateThought({ userId: event.privateIdentity.userId, scope: job.scope,
                  epoch: epochToken.epoch, logicalReplyId: material.logicalReplyId,
                  inboundIds: privateInboundIds(event), thought: event.privateThought })), 'private-thought');
            }
            results.browseIntent = await submitDeliveredBrowseIntent(event, { ok: true, textComplete: true }, { durable: true });
          }
        } else results.memory = { skipped: true, reason: current ? 'not-conversation-memory' : 'memory-epoch-changed' };
        if (event.lifeIncomingTokens?.length && material.kind !== 'status') {
          results.contact = completedPwaSink(await lifeContacts.reconcilePwaIncoming(event.lifeIncomingTokens, { sentMessageIds: event.sentMessageIds }), 'contact');
        }
        if (material.intentId && !material.decisionId) results.intent = completedPwaSink(await lifeContacts?.reconcilePwaIntent(material.intentId), 'intent');
        if (event.lifeReplyEpisodeId) results.busy = completedPwaSink(await lifeReplies?.reconcilePwaDelivery?.({
          episodeId: event.lifeReplyEpisodeId, kind: material.kind === 'status' ? 'status' : 'reply', sentMessageIds: event.sentMessageIds }), 'busy');
        if (material.decisionId) results.conversation = completedPwaSink(await lifeConversation?.reconcilePwaDelivery?.(material.decisionId), 'conversation');
        pwaStore.completeProjection(job.id, { ok: true, ...results });
      } catch (error) {
        if (job) pwaStore.failProjection(job.id, 'core-projection-failed');
        console.error('PWA projection pending recovery:', pending.id, error.code || error.name);
      }
    }
  } finally { pwaProjectionRunning = false; }
}

async function pumpPwaInbox() {
  if (!pwaStore || pwaPumpRunning || serviceLifecycle?.stopping) return;
  pwaPumpRunning = true;
  let rescan = false;
  try {
    await flushPwaProjections();
    if (!pwaWritable()) return;
    const queued = [];
    const settledVersion = pwaInboxSettledVersion;
    // First project every accepted input, before dispatching any generation.
    // SQLite acceptance itself already fences older output in publishSegments.
    // Fix a high watermark so newly arriving work cannot extend this scan
    // forever. Keyset pages also pass earlier blocked/active scopes safely.
    const throughSeq = pwaStore.pendingInboxHighWatermark();
    let afterSeq = 0;
    while (afterSeq < throughSeq) {
    const page = pwaStore.listPendingInbox({ limit: 1000, afterSeq, throughSeq });
    if (!page.length) break;
    afterSeq = page.at(-1).message.seq;
    for (let inbox of page) {
      if (pwaActiveInbox.has(inbox.id)) continue;
      const payload = pwaPayloadForInbox(inbox);
      const identity = inbox.identity;
      const event = normalizePrivateEvent(payload, { channel: 'pwa', privateIdentity: identity });
      if (!pwaIdentityCurrent(event, pwaStore)) {
        pwaStore.completeInbox(inbox.id, { state: 'cancelled', reason: 'identity-or-route-changed' }); continue;
      }
      let context = inbox.context;
      if (inbox.state === 'accepted') {
        const capturedEpoch = await unifiedMemory.captureEpoch({ scope: memoryScope(event) });
        const contactToken = await lifeContacts.observeIncoming(event, { epochToken: capturedEpoch });
        // A contact receipt may already exist after a crash before the SQLite
        // acknowledgement. Preserve its old epoch through a later memory reset.
        const memoryEpochToken = lifeContacts.incomingEpoch(contactToken) || capturedEpoch;
        context = { channel: 'pwa', privateIdentity: identity, memoryEpochToken,
          contactToken, lifeIncomingTokens: [contactToken], contactEvidence: contactEvidenceFor(event, contactToken) };
        inbox = pwaStore.markInboxProjected(inbox.id, context);
        if (contactToken.stop) { pwaStore.completeInbox(inbox.id, { reason: 'contact-stop' }); continue; }
      }
      if (!context?.contactToken || !context.memoryEpochToken) throw Error('PWA intake missing durable contact context');
      if (event.backendCommand) {
        if (inbox.state === 'processing') {
          // A process may have exited after an administrator action but before
          // its result. Never replay arbitrary administrative side effects.
          pwaStore.completeInbox(inbox.id, { state: 'failed', reason: 'command-outcome-unknown' }); continue;
        }
        await lifeContacts.cancelIncoming(context.lifeIncomingTokens, 'presence-only');
        context = { ...context, lifeIncomingTokens: [] };
      } else {
        const delivery = lifeContacts.incomingState(context.contactToken);
        if (delivery === 'sent') { pwaStore.completeInbox(inbox.id, { reason: 'durable-delivery-reconciled' }); continue; }
        if (delivery === 'uncertain' || delivery === 'sending') {
          // All durable mailbox projections have already reconciled published
          // delivery. No published result exists for this remaining input.
          if (pwaStore.hasPendingProjection(identity.memoryScope)) continue;
          await lifeContacts.recoverPwaIncoming(context.lifeIncomingTokens);
        }
      }
      if (!await unifiedMemory.isEpochCurrent(context.memoryEpochToken)) {
        await lifeContacts.cancelIncoming(context.lifeIncomingTokens);
        pwaStore.completeInbox(inbox.id, { state: 'cancelled', reason: 'memory-epoch-changed' }); continue;
      }
      queued.push({ inbox, payload, context, event });
    }
    }
    // An old attempt can settle while a newer accepted input is awaiting its
    // contact projection. Rebuild in durable message order before queuing: the
    // earlier inbox may have been active (and skipped) at the start of this scan.
    // The dispatch loop below has no awaits, so this check and admission form
    // one event-loop turn; a still-active attempt is replaced by MessageBatches.
    if (pwaInboxSettledVersion !== settledVersion) { rescan = true; return; }
    for (const { inbox, payload, context, event } of queued) {
      const scope = context.privateIdentity.memoryScope;
      // A newer accepted input may be beyond this bounded scan or may have
      // arrived during projection. Do not generate against an incomplete scope.
      if (pwaStore.hasPendingProjection(scope) || pwaStore.hasAcceptedInbox(scope)) continue;
      let reservation;
      if (!event.backendCommand) {
        lifeConversation?.observeIncoming(event, context.contactToken);
        if (lifeAvailable() && lifeReplies) {
          reservation = lifeReplies.reserveIncoming(event);
          if (!reservation.ok) continue;
        }
      }
      pwaStore.claimInbox(inbox.id);
      pwaActiveInbox.add(inbox.id); activeEvents++;
      messageBatches.push(payload, context).then(result => {
        // The replacement still owns these inputs only in memory. Keep every
        // original inbox recoverable until its final reply or durable deferral.
        // Graceful stop can reach a claimed entry while it is still waiting in
        // the batch queue. No conversation happened; retain it for restart.
        if (!result?.merged && !result?.superseded && result?.reason !== 'service-stopping') pwaStore.completeInbox(inbox.id);
      }).catch(error => {
        pwaStore.completeInbox(inbox.id, { state: 'failed', reason: 'private-processing-failed' });
        console.error('PWA input failed:', inbox.id, error.code || error.name);
      }).finally(() => {
        if (reservation?.id) lifeReplies?.releaseIncomingReservation(reservation.id);
        pwaActiveInbox.delete(inbox.id); activeEvents--;
        pwaInboxSettledVersion++;
        schedulePwaWork();
      });
    }
  } catch (error) { console.error('PWA inbox paused:', error.code || error.name); }
  finally { pwaPumpRunning = false; if (rescan) schedulePwaWork(); }
}
function schedulePwaWork() {
  if (!pwaStore || serviceLifecycle?.stopping) return;
  queueMicrotask(() => { if (!serviceLifecycle?.stopping) void backgroundTask(pumpPwaInbox()); });
}

async function sendPrivateReply(event, reply, { splitText = false } = {}) {
  if (!isPrivateMemoryEvent(event)) return { ok: false, reason: 'Private chat requires a valid participant' };
  // Honour an explicit layout request for this turn, including plain prose that
  // the sender would otherwise divide at explicit paragraph boundaries.
  const wantsOneMessage = splitText && stripMentionText(event.text).split(/[，,。！？!?；;\n]/u).some(
    clause => /^(?:(?:这次|这条回复|请|麻烦)\s*){0,3}(?:只发一条(?:消息)?|用一条消息(?:发完|回复)|(?:别|不要|不用)分(?:段|开发|成几条发))(?:就好|就行|即可)?$/u.test(clause.trim())
  );
  const message = await buildPrivateReplyMessage(reply);
  let outcome;
  try { outcome = await inReplyOrder(privateQueueKey(event), async () => {
    if (/^\s*\//.test(event.text || '')) {
      const commandDelayMs = 2000 + Math.floor(Math.random() * 4001);
      if (event.timings) event.timings.commandDelayMs = commandDelayMs;
      await sleep(commandDelayMs);
    }
    const result = await sendTextThenSticker(message, (segments, { textComplete = true } = {}) => sendCurrentPrivateSegments(event, segments, textComplete),
      { splitText: splitText && !wantsOneMessage && !event.creativeWorkId });
    return sendRetrievalExpiryFallback(event, result);
  }); return outcome;
  } catch (error) { outcome = { ok: false, uncertain: event.lifeTransportStarted === true }; throw error; }
  finally { await finishPrivateIncoming(event, outcome); }
}

async function privateEvidenceFailure(event) {
  try { if (event.chatEvidenceValidity) await event.chatEvidenceValidity(); }
  catch (error) { return error?.code === 'RETRIEVAL_EVIDENCE_EXPIRED' ? 'retrieval-evidence-expired' : 'retrieval-evidence-changed'; }
  try { if (event.videoEvidenceValidity) await event.videoEvidenceValidity(); }
  catch (error) { return error?.code === 'VIDEO_EVIDENCE_EXPIRED' ? 'video-evidence-expired' : 'video-evidence-changed'; }
  return null;
}

async function sendRetrievalExpiryFallback(event, outcome) {
  discardCancelledWork(event, outcome?.reason);
  if (!['retrieval-evidence-expired', 'video-evidence-expired'].includes(outcome?.reason) || event.sentMessageIds?.length) return outcome;
  // The user still receives one outcome for their accepted input. No new
  // search/model call, stale draft, expression learning or image is released.
  const text = outcome.reason === 'video-evidence-expired' ? '刚才取得的视频资料已经过时，这次先不据此作答。' : '刚才查到的资料已经过时，这次先不据此作答。';
  event.chatEvidenceValidity = null;
  event.videoEvidenceValidity = null;
  event.retrievalFallbackText = text;
  event.creativeWorkId = null;
  event.skipExchangeMemory = true; event.pwaSkipMemory = true; event.learningModelReply = false;
  event.learningSelectionMaterial = undefined; event.learningSelectionCommit = undefined; event.lifeBrowseIntent = null;
  event.privateThought = null;
  const result = await sendCurrentPrivateSegments(event, [{ type: 'text', data: { text } }]);
  return { ...result, deliveredText: result.ok ? text : '', textComplete: result.ok === true };
}

function isCurrentLifeReply(event) {
  if (event.backendCommand === true) return true;
  if (!lifeContacts || contactFailure) return false;
  return isLifeReplyEligible(event) && lifeContacts.isCurrent(event.lifeContactToken);
}

// Run inside the recipient's send queue, immediately before each transport
// invocation. A text reply and its optional sticker are separate boundaries.
async function finishPrivateIncoming(event, result) {
  if (!event.lifeDeliveryClaimed || event.lifeStatusActivityId || event.pwaStatusReply) return;
  try {
    await lifeContacts.finishIncoming(event.lifeIncomingTokens, { ok: result?.ok === true,
      uncertain: result?.uncertain === true || event.lifeDeliveryUncertain === true,
      sentMessageIds: event.sentMessageIds || [], reason: result?.reason });
    event.lifeDeliveryClaimed = false;
    if (result?.reason === 'memory-epoch-changed') await lifeContacts.cancelIncoming(event.lifeIncomingTokens);
  } catch { persistenceFailed = true; console.error('Incoming delivery completion could not persist; sending claim remains uncertain'); }
}
function sendCurrentPrivateSegments(event, segments, textComplete = false) {
  if (event.personaToken && !personaPolicy?.isCurrent(event.personaToken)) return Promise.resolve({ ok: false, reason: 'persona-revision-changed' });
  if (event.replyTurn?.signal.aborted) return Promise.resolve({ ok: false, reason: 'reply-superseded' });
  if (!isCurrentLifeReply(event)) return Promise.resolve({ ok: false, reason: 'contact-epoch-superseded' });
  const send = async () => {
    // The coordinator may wait for an earlier state write. Recheck permissions
    // and a catch-up's availability after that wait as well as after send order.
    if (!isCurrentLifeReply(event)) return { ok: false, reason: 'contact-epoch-superseded' };
    if (!privateInputCurrent(event)) return { ok: false, reason: 'new-input-accepted' };
    const evidenceFailure = await privateEvidenceFailure(event);
    if (evidenceFailure) return { ok: false, reason: evidenceFailure };
    if (lifeAvailable() && event.backendCommand !== true) {
      const available = lifeTimeline.availability({ scope: memoryScope(event) });
      if (event.lifeStatusActivityId) {
        if (!available.busy || available.activityId !== event.lifeStatusActivityId) return { ok: false, reason: 'life-status-expired' };
      } else if (available.busy || (lifeConversation && !lifeConversation.isReplyCurrent(event.lifeReplyTicket))) {
        return { ok: false, reason: 'life-choice-replaced' };
      }
    }
    if (!event.lifeStatusActivityId && !event.pwaStatusReply && event.backendCommand !== true && !event.lifeDeliveryClaimed) {
      const claim = await lifeContacts.beginIncoming(event.lifeIncomingTokens);
      if (!claim.ok) return claim;
      event.lifeDeliveryClaimed = true;
      if (event.lifeMarkSending && !await event.lifeMarkSending()) return { ok: false, reason: 'contact-stopped-or-stale' };
    }
    if (event.backendCommand !== true && (!personaCurrent() || event.personaToken && !personaPolicy?.isCurrent(event.personaToken))) return { ok: false, reason: 'persona-revision-changed' };
    if (event.learningValidity && !await event.learningValidity()) return { ok: false, reason: 'learned-source-changed' };
    // Claims may wait for fsync. No new stop or replacement may cross transport.
    if (!isCurrentLifeReply(event)) return { ok: false, reason: 'contact-epoch-superseded' };
    if (!privateInputCurrent(event)) return { ok: false, reason: 'new-input-accepted' };
    if (lifeAvailable() && event.backendCommand !== true) {
      const latest = lifeTimeline.availability({ scope: memoryScope(event) });
      if (event.lifeStatusActivityId ? !latest.busy || latest.activityId !== event.lifeStatusActivityId
        : latest.busy || lifeConversation && !lifeConversation.isReplyCurrent(event.lifeReplyTicket)) return { ok: false, reason: 'life-choice-replaced' };
    }
    // Lock the candidate at the actual transport boundary, after any awaited
    // contact checks. A later input must never replay an uncertain/partial send.
    if (!await readingNotesCurrent(event.noteRefs, { scope: memoryScope(event), epochToken: event.memoryEpochToken })) {
      return { ok: false, reason: 'note-source-changed' };
    }
    if (event.learningValidity && !await event.learningValidity()) return { ok: false, reason: 'learned-source-changed' };
    if (event.backendCommand !== true && (!personaCurrent() || event.personaToken && !personaPolicy?.isCurrent(event.personaToken))) return { ok: false, reason: 'persona-revision-changed' };
    if (!isCurrentLifeReply(event)) return { ok: false, reason: 'contact-epoch-superseded' };
    if (event.replyTurn && !event.replyTurn.beginDelivery()) return { ok: false, reason: 'reply-superseded' };
    if (!privateInputCurrent(event)) return { ok: false, reason: 'new-input-accepted' };
    event.lifeTransportStarted = true;
    try {
      const result = await dispatchPrivateSegments(event, segments, null, textComplete);
      const id = result.ok ? result.body?.data?.message_id : null;
      if (id != null) event.sentMessageIds = [...new Set([...(event.sentMessageIds || []), String(id)])].slice(-8);
      if (result.uncertain) event.lifeDeliveryUncertain = true;
      return result;
    } catch (error) { event.lifeDeliveryUncertain = true; throw error; }
  };
  const guarded = () => event.backendCommand === true ? send()
    : unifiedMemory.withEpoch(event.memoryEpochToken, send);
  return lifeContacts && event.backendCommand !== true
    ? lifeContacts.sendIfCurrent(event.lifeContactToken, guarded)
    : guarded();
}


async function buildPrivateReplyMessage(reply) {
  reply = ensureStickerLeadText(reply);
  const message = [];
  const imagePaths = await resolveReplyMedia(reply, { stickerDir: stickerDir });
  const text = stripImageAttachmentMarkers(reply);
  if (text) {
    message.push({
      type: "text",
      data: { text }
    });
  }
  for (const imagePath of imagePaths) {
    message.push(buildImageSegment(imagePath));
  }
  if (message.length === 0) {
    message.push({
      type: "text",
      data: { text: "这个表情包没找到，请先把素材放进表情包库。" }
    });
  }
  return message;
}





function dedupePrivateImages(images) {
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

async function pwaEventHistoryCurrent(event) {
  if (!event.pwaHistoryRefs?.length) return true;
  return Boolean(isPwaEvent(event) && pwaIdentityCurrent(event, pwaStore)
    && await pwaHistorySourcesCurrent(pwaHistory, event.privateIdentity.userId, event.pwaHistoryRefs)
    && pwaIdentityCurrent(event, pwaStore));
}

async function attachReplyContext(event) {
  if (!event.replyMessageId && !event.pwaReplyRefs?.length) return event;
  if (isPwaEvent(event)) {
    const refs = [...new Set(event.pwaReplyRefs || [pwaMessageId(event.replyMessageId)])];
    const contexts = [], fingerprints = []; let missing = false;
    for (const ref of refs) {
      try {
        const quoted = await pwaHistory.resolve(event.privateIdentity.userId, ref);
        if (!pwaIdentityCurrent(event, pwaStore)) throw Error('History identity changed');
        const isSelf = quoted.speaker === 'assistant';
        fingerprints.push({ id: quoted.id, fingerprint: pwaHistoryFingerprint(quoted) });
        contexts.push({ messageId: quoted.id, senderId: isSelf ? 'assistant' : event.senderId,
          senderName: isSelf ? assistantName : event.senderName,
          text: quoted.text || '', images: (quoted.mediaIds || []).map(id => ({ file: id })),
          source: quoted.source, createdAt: quoted.createdAt, truncated: quoted.truncated, mediaMissing: quoted.mediaMissing,
          quotedText: quoted.quotedText, quotedTruncated: quoted.quotedTruncated,
          isSelf, scopeVerified: true });
      } catch { missing = true; }
    }
    const combined = contexts.length ? { ...contexts[0], text: contexts.map(context => context.text).join('\n'),
      images: contexts.flatMap(context => context.images) } : undefined;
    return { ...event, isReplyToSelf: Boolean(combined?.isSelf), replyContext: combined,
      pwaReplyContexts: contexts, pwaHistoryRefs: fingerprints,
      replyContextError: missing ? '部分引用消息已不可用' : undefined };
  }
  return { ...event, replyContextError: '引用来源不可用', isReplyToSelf: false };
}





function privateInputCurrent(event) {
  return isPrivateMemoryEvent(event) && pwaIdentityCurrent(event, pwaStore, { generation: true });
}
function capturePrivateRoute(event) { return event; }
async function awaitPrivateProjection(scope) {
  while (pwaStore?.hasPendingProjection(scope)) {
    if (serviceLifecycle?.stopping) return false;
    await flushPwaProjections();
    if (pwaStore.hasPendingProjection(scope)) await sleep(250);
  }
  return !serviceLifecycle?.stopping;
}
function refreshPrivateEvent(event) {
  if (!isPwaEvent(event)) return { ...event, isOwner: false, backendCommand: false };
  const identity = event.privateIdentity;
  const current = pwaStore?.getIdentity(identity?.userId);
  const isOwner = Boolean(current?.enabled && current.bindingStatus === 'active' && current.role === 'admin'
    && current.memoryScope === identity?.memoryScope && identity?.role === 'admin');
  return { ...event, isOwner, backendCommand: isBackendPrivateCommand({ ...event, isOwner }),
    senderLabel: isOwner ? ownerLabel : event.senderName || '对方' };
}
function normalizePrivateEvent(payload, context = {}) {
  if (context.channel !== 'pwa') throw Error('Unsupported private transport');
  return refreshPrivateEvent(trustedPwaEvent(normalizePrivatePayload(payload), context.privateIdentity));
}



function getEventDedupeKey(event) {
  const raw = event.raw || {};
  if (raw.message_id != null) return `message_id:${event.senderId}:${raw.message_id}`;
  return null;
}

function rememberEvent(key) {
  if (!key) return false;
  const now = Date.now();
  for (const [seenKey, seenAt] of seenPrivateMessageIds) {
    if (now - seenAt > seenMessageTtlMs) seenPrivateMessageIds.delete(seenKey);
  }
  if (seenPrivateMessageIds.has(key)) return true;
  seenPrivateMessageIds.set(key, now);
  return false;
}

async function handleApi(req, res) {
  if (req.method === 'GET' && req.url === '/api/platform') {
    return sendJson(res, 200, { platform: process.platform, imessage: isMac,
      worldEnabled: Boolean(world), lifeEnabled: Boolean(lifeTimeline), lifePlanningEnabled: Boolean(lifePlanner), privateOnly: true,
      lifeOperational: lifeAvailable(), worldOperational: Boolean(world), contactOperational: Boolean(lifeContacts && !contactFailure
        && !lifeContacts.diagnostics().failed && !lifeContacts.diagnostics().closed),
      autonomousBrowsingOperational: browseIntentsAvailable(),
      runtimeBudget: runtimeBudget.getStatus(),
      skills: Object.keys(installedSkills), chatSkill: resolveChatSkill(installedSkills, localConfig.chatSkill),
      remoteEnabled: privateTasks.enabled, remoteBusy: privateTasks.busy,
      workspace: localConfig.workspace, privateTransport: 'pwa' });
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
    if (!["imessage"].includes(body.channel)) {
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
state.privateChat.privateOnly = true;
if (localConfig.assistantName) assistantName = localConfig.assistantName;
assistantMentionAliases = normalizeList([...assistantMentionAliases, '@' + assistantName]);
if (localConfig.chatModel) state.ai.model = localConfig.chatModel;
if (isValidReasoningEffort(localConfig.chatReasoningEffort)) state.ai.reasoningEffort = localConfig.chatReasoningEffort;
await mkdir(localConfig.workspace, { recursive: true });
await mkdir(stickerDir, { recursive: true });
await loadIMessageMemory();
await loadRemoteExecutionMemory();
updateIMessagePoller();

// Contact receipt/consent state remains available even when optional life/world
// projections cannot recover. A corrupt contact ledger itself never permits send.
try { lifeContacts = await createLifeContacts({ directory: join(dataDir, 'life') }); }
catch (error) { contactFailure = error; console.error('Private contact state unavailable; ordinary ingress is held for recovery'); }
unifiedMemory.subscribeLearningInvalidation(async event => {
  if (['reset', 'correction', 'source-loss'].includes(event.reason)
    && (event.scope === 'all' || isPrivateScope(event.scope))) await lifeContacts?.forgetPauseEvidence(event.scope);
});
try { world = localConfig.world?.enabled ? await createWorld({ projectDir, config: localConfig, runtimeBudget, personaPolicy,
  runtimeCapabilities: options => currentRuntimeCapabilities(options),
  isMemoryEpochCurrent: token => unifiedMemory.isEpochCurrent(token),
  captureMemoryEpoch: options => unifiedMemory.captureEpoch(options),
  ...(localConfig.life?.enabled === true ? { recordExperience: input => {
    if (!lifeTimeline) throw Error('Life timeline is not ready for reading experiences');
    return lifeTimeline.recordExperience(input).then(result => { pumpLifeConversation(); return result; });
  } } : {}) }) : null;
} catch (error) { console.error('Optional world unavailable; private chat remains available:', error.message); }
const handleWorld = world ? createWorldHttp(world, { projectDir }) : null;
if (localConfig.life?.enabled === true) {
  const directory = join(dataDir, 'life');
  try {
    if (!lifeContacts) throw Error('Contact state is unavailable');
    lifeTimeline = await createLifeTimeline({ directory, personaPolicy });
    personalLifeState = createLifeState({ timeline: lifeTimeline, personaPolicy });
    // Validate the recovered projection before accepting a chat or planning call.
    personalLifeState.snapshot();
    // Replay only durable reading outcomes. This does not reopen pages or call
    // a model, and must finish before any planning or private chat sees state.
    await world?.flushLifeExperiences();
    personalLifeState.snapshot();
    lifeConversation = await createLifeConversation({ directory, timeline: lifeTimeline, contacts: lifeContacts,
      readContext: readLifeConversationContext, decide: decideLifeConversation, dispatch: dispatchLifeConversation,
      isEligible: scope => isLifeContactEligible(contactEventFor(scope)) });
    lifeReplies = await createLifeReplies({ directory, timeline: lifeTimeline, contacts: lifeContacts,
      isEligible: isLifeReplyEligible,
      isPaused: event => isPwaEvent(event) && !pwaWritable(),
      sendStatus: async (event, text) => {
        if (!isLifeReplyEligible(event)) return { ok: false };
        const statusEvent = { ...event, lifeStatusActivityId: lifeTimeline.availability({ scope: memoryScope(event) }).activityId };
        const result = await inReplyOrder(privateQueueKey(event), () => sendCurrentPrivateSegments(statusEvent, [{ type: 'text', data: { text } }]));
        pwaActiveLogical.delete(statusEvent.pwaLogicalReplyId);
        if (isPwaEvent(statusEvent)) await flushPwaProjections();
        return result;
      },
      reply: resumeLifeReply });
    if (localConfig.life.planning?.enabled === true) {
      if (!world) throw Error('生活规划需要启用world以复用受限模型和预算');
      lifePlanner = await createLifePlanner({ directory, timeline: lifeTimeline, personalState: personalLifeState,
        enforceDailyLimit: localConfig.runtimeBudget?.mode !== 'observe',
        readNotes: context => recallReadingNotes({ query: [
          ...context.thoughts.map(item => item.text), ...context.experiences.map(item => item.summary || ''),
          ...(context.longTermInterests || []).map(item => item.label || item.topic || '')].join('\n'),
          explore: true, limit: 3, maxChars: 3600,
          excludeText: context.experiences.map(item => item.summary || '').join('\n') }),
        validateNoteRefs: readingNotesCurrent,
        decide: context => world.planLife(context) });
      lifeBrowsing = createLifeBrowsing({ timeline: lifeTimeline, world });
      lifeProactive = createLifeProactive({ timeline: lifeTimeline, contacts: lifeContacts,
        readCandidate: readLifeContactCandidate, decide: decideLifeContact,
        validateNoteRefs: readingNotesCurrent,
        isEligible: scope => isLifeContactEligible(contactEventFor(scope)), dispatch: dispatchLifeContact });
      if (browseIntentsEnabled) {
        try { lifeBrowseIntents = await createLifeBrowseIntents({ directory, timeline: lifeTimeline, world,
          decide: decideLifeBrowseIntent, isCurrent: intent => unifiedMemory.isEpochCurrent(intent.epochToken) }); }
        catch { lifeBrowseFailure = true; console.error('Autonomous browsing unavailable; other life functions remain available'); }
      }
    }
  } catch (error) {
    suspendLife(error);
    await Promise.allSettled([lifeConversation?.close(), lifeReplies?.close(), lifePlanner?.close(), lifeBrowsing?.close(), lifeProactive?.close(), lifeBrowseIntents?.close()]);
    await lifeTimeline?.close().catch(() => {});
    lifeConversation = null; lifeReplies = null; lifePlanner = null; lifeBrowsing = null; lifeProactive = null; lifeBrowseIntents = null;
    lifeTimeline = null; personalLifeState = null;
  }
  reportLifeWarnings();
}
if (lifeAvailable() && pwaWritable() && pwaConfig.privateThoughtsEnabled === true && pwaConfig.privateThoughtActionsEnabled === true) {
  privateThoughtActions = createPrivateThoughtActions({ store: pwaStore, decide: decidePrivateThought,
    isCurrent: privateThoughtCurrent, canRead: () => state.privateChat.webLookup.enabled === true });
}
if (lifeAvailable() && pwaWritable() && pwaStore && pwaConfig.spaceEnabled === true) {
  const canPublish = () => lifeAvailable() && pwaWritable() && !serviceLifecycle?.stopping && personaCurrent();
  const publisher = createSpacePublisher({ store: pwaStore, decide: input => decideInSpace('space-post', input), canPublish, readArticle: createListedSpaceReader(),
    readVideo: (url, options) => videoReader?.readForSpace(url, options) });
  spaceTimeline = createSpaceTimeline({ timeline: lifeTimeline, store: pwaStore, publisher, canPublish });
  spaceCommentReplies = createSpaceCommentReplies({ store: pwaStore, decide: input => decideInSpace('space-comment-reply', input), canReply: canPublish });
}
// Once planning owns the timeline, the old autonomous browser timer must not compete with it.
if (!lifePlanner) world?.startScheduler();
const handleLifeObserver = createLifeObserverHttp({ readSnapshot: () => ({
  enabled: lifeAvailable(),
  snapshot: lifeTimeline?.snapshot(),
  diagnostics: lifeTimeline?.diagnostics,
  operations: lifeOperationalDiagnostics()
}), readContactPauses: () => {
  const diagnostics = lifeContacts?.diagnostics();
  if (!lifeContacts || contactFailure || diagnostics?.failed || diagnostics?.closed) throw Error('Contact state unavailable');
  return lifeContacts.pausedDetails();
} });

function lifeOperationalDiagnostics() {
  const contacts = { enabled: Boolean(lifeContacts), ...lifeContacts?.diagnostics(),
    failed: Boolean(contactFailure || lifeContacts?.diagnostics().failed) };
  try {
    const snapshot = lifeContacts?.snapshot();
    if (snapshot) { contacts.total = snapshot.contacts.length; contacts.paused = lifeContacts.pausedDetails().length; }
  } catch { contacts.failed = true; }
  return {
    planner: { enabled: Boolean(lifePlanner), ...lifePlanner?.diagnostics(),
      ...(lifeFailure ? { failed: true, lastResult: 'storage-unavailable' } : {}) },
    browsing: lifeBrowseIntents?.diagnostics() || { enabled: browseIntentsEnabled, failed: lifeBrowseFailure,
      ...(lifeBrowseFailure ? { lastResult: 'storage-unavailable' } : {}) },
    proactive: { enabled: Boolean(lifeProactive), ...lifeProactive?.diagnostics() },
    learning: privateLearning?.diagnostics() || { enabled: false }, contacts
  };
}

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
    if (serviceLifecycle?.stopping) return sendJson(res, 503, { error: 'Hub stopping; retry later' });
    if (req.url?.startsWith("/api/")) {
      const handled = await handleApi(req, res);
      if (handled !== false) return;
    }
    await serveStatic(req, res);
  } catch (error) {
    sendJson(res, Number.isInteger(error.statusCode) && error.statusCode >= 400 && error.statusCode < 500 ? error.statusCode : 500,
      { error: error.message });
  } finally { activeHttpRequests--; }
});

server.listen(Number(process.env.PORT || 3789), '127.0.0.1', () => {
  console.log(`codexremotecontact chat hub: http://127.0.0.1:${process.env.PORT || 3789}`);
  const clean = () => {
    if (serviceLifecycle?.stopping) return;
    void backgroundTask(Promise.all([pruneTransientFiles(codexTmpDir),
      pruneTransientFiles(join(projectDir, 'tmp', 'private-images'))]))
      .catch(() => console.error('Temporary-file cleanup incomplete; retained for next attempt'));
  };
  clean(); temporaryFilesTimer = setInterval(clean, 3600000); temporaryFilesTimer.unref();
});

async function runPrivateTask(text, skill, history, event = {}) {
  if (!isPrivateMemoryEvent(event) || !event.isOwner) throw Error('Private task requires an authenticated owner');
  await ensureCodexReplyWorkspace();
  const outputPath = join(codexTmpDir, crypto.randomUUID() + '.private-task.txt');
  const temporary = createTransientFiles(); let keepOutput = false;
  try {
  const prompt = [
    `你正在通过 PWA 管理员私聊执行任务。用中文汇报结果和验证情况。`,
    event.fullAccess ? '此任务由管理员确认使用完全访问。仅执行本次请求的操作，遵守本机策略和适用的权限约束。' : '仅在指定工作目录内修改文件。需要额外权限或外部发送时说明阻塞，不绕过沙箱。',
    '当前系统：' + process.platform + '；工作目录：' + localConfig.workspace,
    'Windows 上使用 PowerShell 和 Windows 路径，不调用 AppleScript 或 macOS 命令。',
    skillContext(installedSkills, skill),
    await unifiedMemory.formatForPrompt({ scope: memoryScope(event), query: text }),
    '之前的任务对话（仅作上下文，不重新执行）：' + JSON.stringify(history),
    '本次经管理员确认的任务：', text
  ].join('\n\n');
  const args = ['exec', '--ephemeral', '--skip-git-repo-check', '-s', event.fullAccess ? 'danger-full-access' : 'workspace-write',
    '-C', localConfig.workspace, '-o', outputPath];
  if (localConfig.remoteModel) args.push('-m', localConfig.remoteModel);
  args.push('-');
  await runCodexCli(args, prompt, { budgetPurpose: 'qq-task', temporary, cwd: localConfig.workspace, timeout: 600000, env: { ...process.env } });
  const reply = (await readFile(outputPath, 'utf8')).trim();
  await unifiedMemory.write({ scope: memoryScope(event), type: 'projectNote', source: 'qq-cli-task',
    summary: `任务：${text.slice(0, 600)}\n结果：${reply.slice(0, 1200)}` });
  keepOutput = reply.length > 3500;
  return keepOutput ? reply.slice(0, 3300) + '\n\n完整结果（保留24小时）：' + outputPath : reply || '任务结束，但未返回可读结果。';
  } finally {
    if (!keepOutput) temporary.add(outputPath);
    void backgroundTask(temporary.finish());
  }
}

let activeEvents = 0;
const messageBatches = new MessageBatches({ deliver: processPrivateEvent,
  // Backend controls (especially cancellation) must not wait for a chat model.
  // Unknown slash messages may still become chat, so they stay in the queue.
  isImmediate: payload => isHubCommand(normalizePrivatePayload(payload).text) });
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
    const path = join(projectDir, 'runtime', 'logs', 'private-timings.jsonl');
    await mkdir(join(projectDir, 'runtime', 'logs'), { recursive: true });
    const size = await stat(path).then(s => s.size).catch(() => 0);
    if (size > 2 * 1024 * 1024) await rename(path, path + '.previous');
    await appendFile(path, line);
  });
  timingLogWrites = task.catch(() => { persistenceFailed = true; console.error('Could not save private timing diagnostics'); });
  return timingLogWrites;
}
let localConfigWrites = Promise.resolve();
serviceLifecycle = createServiceLifecycle({
  stopAccepting: () => Promise.all([pwaHttp?.close(), new Promise((resolve, reject) => {
    server.close(error => error && error.code !== 'ERR_SERVER_NOT_RUNNING' ? reject(error) : resolve());
    server.closeIdleConnections?.();
  })]),
  stopBackground: () => {
    videoSources.clear();
    privateLearning?.stop();
    clearInterval(pwaTimer); pwaTimer = null;
    clearInterval(temporaryFilesTimer); temporaryFilesTimer = null;
    clearInterval(lifeTimer); lifeTimer = null;
    clearInterval(imessagePollTimer); imessagePollTimer = null;
    stopRemoteExecutionIdleTimer();
    if (hubCommands.shutdownTimer) clearTimeout(hubCommands.shutdownTimer);
    return Promise.all([pwaPush?.stop(), privateThoughtActions?.close(), spaceTimeline?.close(), spaceCommentReplies?.close(),
      world?.close(), chatRetrieval.close(), publicTopicCatalog.close(), videoReader?.close()]);
  },
  pending: () => activeEvents + activeHttpRequests + activeBackgroundTasks + activeCliProcesses + Number(imessagePolling)
    + (privateLearning?.pending() || 0),
  flush: async () => {
    await flushPwaProjections();
    await Promise.all([localConfigWrites, timingLogWrites]);
    try { await lifeConversation?.close(); await lifeBrowsing?.close(); await lifeBrowseIntents?.close(); await lifeProactive?.close(); await lifePlanner?.close(); await lifeReplies?.close(); await lifeContacts?.close(); }
    finally { try { await lifeTimeline?.close(); await privateLearning?.flush(); } finally { await runtimeBudget.close(); } }
    pwaStore?.close();
    if (persistenceFailed) throw Error('A configuration or timing write failed');
  }
});
process.on('SIGTERM', () => { void serviceLifecycle.stop('SIGTERM'); });
process.on('SIGINT', () => { void serviceLifecycle.stop('SIGINT'); });
const hubCommands = new HubCommands({ config: localConfig, state, memory: { ...unifiedMemory, clear: clearMemoryWithContactEvidence }, world,
  shutdown: () => serviceLifecycle.stop('/关机'),
  workspace: projectDir, saveSettings,
  persist: () => {
    const task = localConfigWrites.then(() => writeJsonAtomic(join(dataDir, 'windows.local.json'), localConfig, { previous: true }));
    localConfigWrites = task.catch(() => { persistenceFailed = true; }); return task;
  }
});
if (pwaStore) {
  const directory = pwaConfig.dataDirectory || join(dataDir, 'pwa');
  const vapid = await loadOrCreateVapidConfig({ filePath: pwaConfig.vapidPath || join(directory, 'vapid.json'), subject: pwaConfig.origin });
  pwaHistory = createPwaHistory({ store: pwaStore, readLegacyHistorySnapshot: options => unifiedMemory.readPwaHistory(options) });
  pwaStickers = await createPwaStickers({ store: pwaStore, media: pwaMedia, sharedDirectory: state.privateChat.enhancer.enabled ? stickerDir : null });
  pwaHttp = createPwaHttp({ store: pwaStore, auth: pwaAuth, media: pwaMedia, history: pwaHistory, stickers: pwaStickers,
    spaceEnabled: pwaConfig.spaceEnabled === true,
    publicDir: join(projectDir, 'modules', 'pwa', 'public'), origin: pwaConfig.origin,
    onAccepted: () => schedulePwaWork(), pushPublicKey: vapid.publicKey, readOnly: pwaConfig.readOnly === true,
    readLegacyHistory: options => unifiedMemory.readLegacyHistory(options) });
  await flushPwaProjections();
  for (const entry of pwaWritable() ? lifeReplies?.pwaRecoveryEntries?.() || [] : []) {
    const event = { type: 'private_message', ...entry.sender, lifeReplyEpisodeId: entry.id,
      raw: { batched_message_ids: entry.messages.map(message => message.id) } };
    const delivery = pwaStore.getDelivery(`${privateLogicalReplyId(event, 'exchange')}:0`);
    if (delivery) {
      await lifeReplies.reconcilePwaDelivery({ episodeId: entry.id, sentMessageIds: delivery.messages.map(message => message.id) });
    } else if (!pwaStore.hasPendingProjection(entry.scope)) {
      await lifeContacts.recoverPwaIncoming(entry.lifeIncomingTokens || []);
      await lifeReplies.recoverPwaDelivery(entry.id);
    }
  }
  await pwaHttp.listen(Number(pwaConfig.port || 3790));
  if (pwaWritable() && pwaConfig.pushEnabled !== false) {
    pwaPush = createPwaPushWorker({ store: pwaStore, vapid, cachePath: join(directory, 'push-auth-cache.json') });
    pwaPush.start();
  }
  pwaTimer = setInterval(schedulePwaWork, 1000); pwaTimer.unref();
  schedulePwaWork();
  console.log('Invitation private chat listener ready on loopback');
}
// Observation, planning and catch-up have independent in-flight guards: a slow
// model cannot stop time advancing. Planning remains explicitly opt-in.
if (lifeTimeline) {
  const requestedInterval = Number(localConfig.life.tickIntervalMs);
  // Starts can be held for thirty seconds. Keep observation and consumption
  // within that window even when an activity is created by another writer.
  const interval = Number.isFinite(requestedInterval) ? Math.max(250, Math.min(15000, requestedInterval)) : 15000;
  lifeTimer = setInterval(() => {
    if (lifeTickPending || serviceLifecycle.stopping || !lifeTimeline || lifeFailure && !lifeFailureRetryable) return;
    lifeTickPending = true;
    // A slow reply must not stop observation of the personal timeline. Track
    // the state tick and network/model drain independently during shutdown too.
    backgroundTask(lifeTimeline.tick()).then(() => {
      // Only a recovered timeline write clears its own runtime suspension.
      // Failed startup objects are null; reply-queue faults still need recovery.
      if (lifeFailureRetryable) { lifeFailure = null; lifeFailureRetryable = false; }
      reportLifeWarnings();
      pumpLifeConversation();
      if (spaceTimeline && !spaceTickPending && !serviceLifecycle.stopping) {
        const task = spaceTimeline.tick();
        if (task) {
          spaceTickPending = true;
          backgroundTask(task).catch(() => console.error('Space publishing interrupted; timeline checkpoint retained'))
            .finally(() => { spaceTickPending = false; });
        }
      }
      if (spaceCommentReplies && !spaceCommentTickPending && !serviceLifecycle.stopping) {
        spaceCommentTickPending = true;
        backgroundTask(spaceCommentReplies.tick())
          .catch(() => console.error('Space comment review interrupted'))
          .finally(() => { spaceCommentTickPending = false; });
      }
      if (privateThoughtActions && !privateThoughtTickPending && !serviceLifecycle.stopping) {
        privateThoughtTickPending = true;
        backgroundTask(privateThoughtActions.tick())
          .catch(() => { console.error('Private thought review interrupted'); })
          .finally(() => { privateThoughtTickPending = false; });
      }
      // A committed reading may wait for wall time to catch up after rollback.
      // Retry its local sinks independently, without another browser/model call
      // or making a transient outbox failure disable ordinary life ticks.
      const readingState = world?.lifeExperienceStatus();
      if (!lifeExperiencePending && !serviceLifecycle.stopping && (readingState?.pending > 0 || readingState?.failed)) {
        lifeExperiencePending = true;
        backgroundTask(world.flushLifeExperiences())
          .then(() => pumpLifeConversation())
          .catch(() => { console.error('Reading experience replay deferred; durable sources preserved'); })
          .finally(() => { lifeExperiencePending = false; });
      }
      if (lifePlanner && !lifePlanningPending && !serviceLifecycle.stopping) {
        lifePlanningPending = true;
        lifePlanningWork = backgroundTask(lifePlanner.tick())
          .then(() => pumpLifeConversation())
          .catch(() => { console.error('Life planning persistence failed; stored state preserved'); })
          .finally(() => { lifePlanningPending = false; });
      }
      if (!lifeActionsPending && !serviceLifecycle.stopping && (lifeBrowsing || lifeBrowseIntents)) {
        lifeActionsPending = true;
        // One reading lane shares world ownership. Ordinary planner gets its
        // bounded call first, but its future nextAt never gates a new desire.
        const planning = lifePlanningWork;
        backgroundTask((async () => {
          await lifeBrowsing?.tick();
          await planning;
          if (!serviceLifecycle.stopping && lifeAvailable()) await lifeBrowseIntents?.tick();
        })()).then(() => pumpLifeConversation())
          .catch(() => { console.error('Life reading action failed; durable claims preserved'); })
          .finally(() => { lifeActionsPending = false; });
      }
      if (!lifeProactivePending && !serviceLifecycle.stopping && lifeProactive) {
        lifeProactivePending = true;
        backgroundTask(lifeProactive.tick()).then(() => pumpLifeConversation())
          .catch(() => { console.error('Life contact action failed; durable claims preserved'); })
          .finally(() => { lifeProactivePending = false; });
      }
      if (lifeDrainPending || serviceLifecycle.stopping) return;
      lifeDrainPending = true;
      backgroundTask(lifeReplies?.drain())
        .catch(() => { console.error('Life reply drain failed; stored state preserved'); })
        .finally(() => { lifeDrainPending = false; });
    }).catch(error => { suspendLife(error, { retryable: true }); })
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
  if (!lifeAvailable() || !lifeConversation || lifeConversationPending || serviceLifecycle?.stopping) return;
  lifeConversationPending = true;
  backgroundTask(lifeConversation.tick())
    .catch(() => { console.error('Life conversation transition failed; stored claims preserved'); })
    .finally(() => { lifeConversationPending = false; });
}

function isLifeIncomingEligible(event) {
  return isPrivateMemoryEvent(event) && pwaWritable() && pwaIdentityCurrent(event, pwaStore);
}

function isLifeContactEligible(event) {
  return isLifeIncomingEligible(event) && refreshPrivateEvent(event).backendCommand !== true;
}

// Only authenticated ingress constructs this evidence. Keep one bounded latest
// own-text message, separately from any batch/quote reconstruction.
function contactEvidenceFor(event, token) {
  if (!token || token.stop) return undefined;
  const text = Array.isArray(event.raw?.message) ? event.raw.message.filter(part => part?.type === 'text')
    .map(part => String(part.data?.text || '')).join('') : String(event.text || '').replace(/\[CQ:[^\]]*\]/gi, '');
  if (!text || text.length > 12000) return undefined;
  return { token: structuredClone(token), event: { type: 'private_message', senderId: String(event.senderId), text,
    ...(isPwaEvent(event) ? { channel: 'pwa', privateIdentity: structuredClone(event.privateIdentity) } : {}),
    raw: { message_id: event.raw?.message_id, message: [{ type: 'text', data: { text } }] } } };
}

function contactEventFor(scope) {
  const identity = pwaStore?.getIdentityForScope(scope);
  if (identity?.preferredChannel === 'pwa') return refreshPrivateEvent(trustedPwaEvent({ type: 'private_message',
    senderName: identity.displayName || '对方', text: '', raw: {} }, identity));
  return { type: 'private_message', channel: 'unavailable', senderId: privateScopeId(scope), text: '', raw: {} };
}

async function recallReadingNotes(options) {
  try { return await world?.recallNotes(options) || { text: '', sources: [] }; }
  catch { console.error('Optional reading-note recall unavailable'); return { text: '', sources: [] }; }
}

async function readingNotesCurrent(refs = [], options = {}) {
  if (!refs?.length) return true;
  try { return await world?.validateNoteRefs(refs, options) === true; }
  catch { return false; }
}

async function readLifeContactCandidate({ scope, motive }) {
  if (!await awaitPrivateProjection(scope)) return null;
  // Capture before any source read; taking a new epoch after recall could
  // authorize text generated from memory that was cleared during the read.
  const epochToken = await unifiedMemory.captureEpoch({ scope });
  const recalled = await unifiedMemory.recall({ scope, query: motive, limit: 1, includeRecent: true });
  const notes = await recallReadingNotes({ scope, query: [motive, recalled.context].filter(Boolean).join('\n'),
    limit: 1, maxChars: 2800, excludeText: recalled.context, epochToken });
  const sources = recalled.entries.map(entry => ({ kind: 'private-memory', ref: `memory:${entry.id}`, scope }));
  sources.push(...notes.sources);
  let context = '';
  for (const block of [notes.text, recalled.context, await unifiedMemory.formatPrivateProfile({ scope }),
    personalLifeState.formatContext({ scope }), lifeTimeline.formatContext({ scope, excludeReading: true })]) {
    if (block && context.length + block.length + 1 <= 12000) context += (context ? '\n' : '') + block;
  }
  if (!await unifiedMemory.isEpochCurrent(epochToken)) return null;
  return { sources, score: recalled.entries.filter(entry => entry.reason === 'relevant').length, context, epochToken };
}

async function runPrivateLearningModel({ prompt, timeoutMs, signal, schema = learningDecisionSchema }) {
  if (serviceLifecycle?.stopping || !personaCurrent()) throw Error('Service or persona generation unavailable');
  const model = localConfig.privateChatModel || (state.ai.model === 'default' ? undefined : state.ai.model);
  const runner = createWorldModel({ directory: join(projectDir, 'runtime', 'private-learning-model'), model,
    reasoningEffort: localConfig.privateChatReasoningEffort || state.ai.reasoningEffort,
    proxy: localConfig.codexProxy, schema, timeoutMs });
  return backgroundTask(runtimeBudget.run({ purpose: 'private-learning' }, () => {
    if (serviceLifecycle?.stopping || !personaCurrent()) throw Error('Service or persona generation unavailable');
    return runner({ prompt, signal });
  }));
}

async function privateThoughtCurrent({ userId, scope, epoch }) {
  if (serviceLifecycle?.stopping || !lifeAvailable() || !pwaWritable() || !personaCurrent()) throw Error('Private thought review unavailable');
  const identity = pwaStore.getIdentity(userId);
  return Boolean(identity?.enabled && identity.bindingStatus === 'active' && identity.memoryScope === scope
    && identity.preferredChannel === 'pwa' && await unifiedMemory.isEpochCurrent({ scope, epoch }));
}

async function decidePrivateThought({ prompt, schema, scope, signal, canContinue }) {
  const model = localConfig.privateChatModel || (state.ai.model === 'default' ? undefined : state.ai.model);
  const runner = createWorldModel({ directory: join(projectDir, 'runtime', 'private-thought-model'), model, schema,
    reasoningEffort: localConfig.privateChatReasoningEffort || state.ai.reasoningEffort,
    proxy: localConfig.codexProxy, timeoutMs: 120000 });
  const profile = await loadAssistantSkillBrief();
  const result = await runtimeBudget.run({ purpose: 'private-thought-review' }, async () => {
    if (signal.aborted || !await canContinue()) throw Error('Private thought review interrupted');
    const currentLife = lifeTimeline.formatContext({ scope, limit: 2, excludeReading: true });
    const reading = state.privateChat.webLookup.enabled ? '目前已开启公开文章取材。' : '目前网页取材关闭。';
    return runner({ prompt: [profile, currentLife, reading, prompt].filter(Boolean).join('\n\n'), signal });
  });
  return result.text;
}

async function decideInSpace(purpose, { prompt, schema, signal, canContinue }) {
  const model = localConfig.privateChatModel || (state.ai.model === 'default' ? undefined : state.ai.model);
  const invoke = createWorldModel({ directory: join(projectDir, 'runtime', purpose + '-model'), model, schema,
    reasoningEffort: localConfig.privateChatReasoningEffort || state.ai.reasoningEffort,
    proxy: localConfig.codexProxy, timeoutMs: 120000 });
  const profile = await loadAssistantSkillBrief();
  const result = await runtimeBudget.run({ purpose }, () => {
    signal.throwIfAborted();
    if (!canContinue()) throw Error('Space decision interrupted');
    return invoke({ prompt: [profile, prompt].filter(Boolean).join('\n\n'), signal });
  });
  return result.text;
}

async function decideLifeBrowseIntent(context, { canContinue = () => true } = {}) {
  if (!personaCurrent()) throw Error('Persona revision changed');
  const prompt = buildLifeBrowseIntentPrompt(await loadAssistantSkillBrief(), { ...context, capabilities: currentRuntimeCapabilities({ entry: 'browse' }) });
  const model = localConfig.world?.model || localConfig.privateChatModel || (state.ai.model === 'default' ? undefined : state.ai.model);
  const runner = createWorldModel({ directory: join(dataDir, 'life', 'browse-intent-model'), model,
    reasoningEffort: localConfig.world?.reasoningEffort || state.ai.reasoningEffort,
    proxy: localConfig.codexProxy, schema: browseIntentDecisionSchema, timeoutMs: 180000 });
  const result = await runtimeBudget.run({ purpose: 'life-browse-intent' }, async () => {
    if (serviceLifecycle?.stopping || !lifeAvailable() || !await canContinue() || !personaCurrent()) throw Error('Life browsing is unavailable');
    return runner({ prompt });
  });
  if (!personaCurrent()) throw Error('Persona revision changed');
  return result.text;
}

async function submitDeliveredBrowseIntent(event, sent, { durable = false } = {}) {
  if (durable && event.lifeBrowseIntent && browseIntentsEnabled
    && (!lifeBrowseIntents || lifeBrowseIntents.diagnostics().failed)) {
    throw Object.assign(Error('Browsing intent storage needs recovery'), { code: 'projection-browse-unavailable' });
  }
  if (!personaCurrent() || !browseIntentsAvailable() || !event.lifeBrowseIntent || event.hubPreview || event.backendCommand === true
    || sent?.ok !== true || sent.textComplete === false || !event.sentMessageIds?.length
    || !isCurrentLifeReply(event) || !event.memoryEpochToken) return { ok: true, skipped: true };
  const ids = event.raw?.batched_message_ids || [event.raw?.message_id];
  if (!Array.isArray(ids) || !ids.length || ids.some(id => id == null || !String(id))) return { ok: true, skipped: true };
  const scope = memoryScope(event);
  // The scope and real incoming batch identify the proposal across restarts.
  // Hashing bounds the ref; it denotes incoming evidence, never a fake memory.
  const batch = createHash('sha256').update(JSON.stringify([scope, ids.map(String)])).digest('hex');
  try {
    const result = await lifeBrowseIntents.submit({ id: `chat:${batch}`, scope, ...event.lifeBrowseIntent,
      sourceRefs: [`incoming:${batch}`], epochToken: event.memoryEpochToken });
    if (durable && !result.accepted && !result.duplicate && result.reason !== 'stale-epoch') {
      throw Object.assign(Error('Browsing intent projection did not commit'), { code: 'projection-browse-incomplete' });
    }
    return result;
  } catch (error) {
    if (durable) throw error;
    console.error('Could not save delivered reply browsing intent');
  }
}

async function decideLifeContact(input, options = {}) {
  const route = capturePrivateRoute(contactEventFor(input.scope));
  if (!await awaitPrivateProjection(input.scope)) throw Error('Private projection interrupted');
  lifeGenerationRoutes.set(options.selectionKey, route);
  if (lifeGenerationRoutes.size > 256) lifeGenerationRoutes.delete(lifeGenerationRoutes.keys().next().value);
  const personaToken = personaPolicy?.capture();
  let experienceCurrent = async () => true;
  let retrievalResult = null;
  const assertCurrent = async () => {
    personaPolicy?.assertCurrent(personaToken);
    if (retrievalResult) await chatRetrieval.assertResultCurrent(retrievalResult);
    if (serviceLifecycle?.stopping || !privateInputCurrent(route) || !isLifeContactEligible(route) || !await unifiedMemory.isEpochCurrent(options.epochToken)
      || options.canContinue && !await options.canContinue() || !await experienceCurrent()) throw Error('Proactive reply no longer current');
    personaPolicy?.assertCurrent(personaToken);
  };
  await assertCurrent();
  lifeGenerationValidity.set(options.selectionKey, assertCurrent);
  if (lifeGenerationValidity.size > 256) lifeGenerationValidity.delete(lifeGenerationValidity.keys().next().value);
  const learned = await privateLearning?.formatContext({ scope: input.scope, userText: input.thought?.text || '',
    paused: lifeContacts?.isPaused(input.scope) === true, proactive: true,
    selectionKey: options.selectionKey, deferSelection: (commit, material) => {
      if (material) {
        lifeGenerationSelections.set(options.selectionKey, material);
        if (lifeGenerationSelections.size > 256) lifeGenerationSelections.delete(lifeGenerationSelections.keys().next().value);
      }
      options.deferSelection?.(commit, material);
    },
    deferValidity: guard => { experienceCurrent = guard; } }) || '';
  const profile = await loadAssistantSkillBrief();
  input = { ...input, context: [input.context, learned].filter(Boolean).join('\n') };
  const capabilityText = currentCapabilityText(route, { entry: 'proactive' });
  const creativeKinds = creativeKindsFor(route);
  const creativePrompt = creativeDecisionPrompt(creativeKinds);
  const prompt = [capabilityText, sharedReplyContract(), buildProactivePrompt(profile, input), creativePrompt].filter(Boolean).join('\n\n');
  const sourceOptions = { sources: input.sources, motiveRef: input.motiveRef, scope: input.scope };
  const finish = async decision => {
    const reply = decision.creativeWork
      ? await makePrivateWork(route, creativeBinding(route, outboundLogicalId(input.scope, options.selectionKey), options.epochToken, personaToken), decision.creativeWork, assertCurrent)
      : decision.reply;
    return JSON.stringify({ reply, sourceRefs: decision.sourceRefs });
  };
  const caller = { model: localConfig.privateChatModel || localConfig.world?.model || (state.ai.model === 'default' ? undefined : state.ai.model),
    reasoningEffort: localConfig.privateChatReasoningEffort || state.ai.reasoningEffort };
  if (state.privateChat.webLookup.enabled === true) {
    return withCurrentReplySignal(assertCurrent, async ({ signal, assertCurrent: current }) => {
      const topics = await prepareChatPublicTopics({ text: [input.thought?.text, input.context].filter(Boolean).join('\n'),
        signal, assertCurrent: current });
      let evidence = '';
      for (let generation = 0; generation < 2; generation++) {
        const allowLookup = generation === 0 && topics.length > 0;
        const lookupPrompt = capabilityText + '\n\n' + sharedReplyContract() + '\n\n'
          + buildProactiveRetrievalPrompt(profile, input, { topics, allowLookup, evidence }) + '\n' + creativePrompt;
        const runner = createWorldModel({ directory: join(dataDir, 'life', 'contact-model'), ...resolveReplyWriter(replySettings, caller),
          proxy: localConfig.codexProxy, schema: withCreativeSchema(proactiveRetrievalSchema, creativeKinds), timeoutMs: 300000 });
        const result = await backgroundTask(runtimeBudget.run({ purpose: generation ? 'life-contact-lookup' : 'life-contact' },
          () => measureModelCall(async () => { await current(); return runner({ prompt: lookupPrompt, signal }); })));
        await current();
        const decision = readCreativeDecision(result.text, creativeKinds,
          value => parseProactiveRetrieval(value, { topics, allowLookup, ...sourceOptions }));
        if (decision.action === 'reply') return finish(decision);
        const retrieved = await retrieveChatEvidence({
          request: { version: 1, id: crypto.randomUUID(), turnId: options.selectionKey,
            scope: { kind: 'private', contactId: input.scope, memoryEpoch: options.epochToken?.epoch }, publicQuery: decision.lookup },
          topics, signal, assertCurrent: current });
        retrievalResult = retrieved;
        route.chatEvidenceValidity = () => chatRetrieval.assertResultCurrent(retrieved);
        await current();
        evidence = formatRetrievalEvidence(retrieved);
        state.maintenance.webLookup.lastQuery = null;
        state.maintenance.webLookup.lastRunAt = new Date().toISOString();
        state.maintenance.webLookup.lastOk = ['ok', 'partial'].includes(retrieved.status);
        state.maintenance.webLookup.lastError = retrieved.errorCode || null;
        state.maintenance.webLookup.lastDurationMs = retrieved.metrics?.http?.durationMs ?? retrieved.metrics?.durationMs ?? null;
      }
      throw Error('Proactive lookup did not produce a final decision');
    });
  }
  if (replySettings.mode === 'two-stage') {
    const raw = await generateLifePlannedReply({ mode: 'proactive', prompt, input, caller, assertCurrent, profile, capabilityText, creativeKinds });
    return finish(readCreativeDecision(raw, creativeKinds, value => parseProactiveDecision(value, sourceOptions)));
  }
  const runner = createWorldModel({ directory: join(dataDir, 'life', 'contact-model'), ...resolveReplyWriter(replySettings, caller),
    proxy: localConfig.codexProxy, schema: withCreativeSchema(proactiveDecisionSchema, creativeKinds), timeoutMs: 300000 });
  const result = await runtimeBudget.run({ purpose: 'life-contact' }, async () => { await assertCurrent(); return runner({ prompt }); });
  await assertCurrent();
  return finish(readCreativeDecision(result.text, creativeKinds, value => parseProactiveDecision(value, sourceOptions)));
}

async function readLifeConversationContext({ scope, event, thought }) {
  if (!await awaitPrivateProjection(scope)) throw Error('Private projection interrupted');
  const epochToken = await unifiedMemory.captureEpoch({ scope });
  const recalled = await unifiedMemory.recall({ scope,
    query: [event.text, thought.text].filter(Boolean).join('\n'), limit: 4 });
  let context = '';
  for (const block of [recalled.context, await unifiedMemory.formatPrivateProfile({ scope }),
    personalLifeState.formatContext({ scope }), lifeTimeline.formatContext({ scope, excludeReading: true })]) {
    if (block && context.length + block.length + 1 <= 12000) context += (context ? '\n' : '') + block;
  }
  if (!await unifiedMemory.isEpochCurrent(epochToken)) throw Error('Conversation memory epoch changed');
  return { context, epochToken, sources: recalled.entries.slice(0, 4).map(entry => ({ kind: 'private-memory', ref: `memory:${entry.id}`, scope })) };
}

async function decideLifeConversation(input, options = {}) {
  const route = capturePrivateRoute(contactEventFor(input.scope));
  if (!await awaitPrivateProjection(input.scope)) throw Error('Private projection interrupted');
  lifeGenerationRoutes.set(input.decisionId, route);
  if (lifeGenerationRoutes.size > 256) lifeGenerationRoutes.delete(lifeGenerationRoutes.keys().next().value);
  const deadline = Math.min(input.deadline, Date.now() + 25000);
  const personaToken = personaPolicy?.capture();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.max(1, deadline - Date.now()));
  const event = { replyTurn: { signal: controller.signal } };
  const assertCurrent = async () => {
    personaPolicy?.assertCurrent(personaToken);
    if (!await unifiedMemory.isEpochCurrent(options.epochToken)) throw Object.assign(Error('Conversation memory epoch changed'), { code: 'CONVERSATION_CHANGED' });
    const plan = lifeTimeline.snapshot().plans.find(item => item.id === input.plan.id);
    const current = lifeContacts.capture(input.scope);
    const choice = lifeConversation.snapshot(input.scope).choices.find(item => item.id === input.decisionId);
    if (controller.signal.aborted || serviceLifecycle?.stopping || !privateInputCurrent(route) || !isLifeContactEligible(route)
      || plan?.status !== 'planned' || plan.startTransition?.status !== 'pending'
      || plan.startTransition.id !== input.decisionId || Date.now() < plan.startTransition.claimedAt
      || Date.now() >= deadline || current?.epoch !== input.token.epoch || current?.sequence !== input.token.sequence
      || choice?.status !== 'generating' || !lifeContacts.isCurrent(input.token, { latest: true }) || !isLifeContactEligible(contactEventFor(input.scope))) {
      throw Object.assign(Error('Conversation choice is no longer current'), { code: controller.signal.aborted || Date.now() >= deadline ? 'CONVERSATION_TIMEOUT' : 'CONVERSATION_CHANGED' });
    }
    personaPolicy?.assertCurrent(personaToken);
  };
  try {
    await assertCurrent();
    await privateLearning?.initialize(input.scope).catch(() => {});
    const profile = await loadAssistantSkillBrief();
    const capabilityText = currentCapabilityText(route, { entry: 'conversation' });
    const prompt = capabilityText + '\n\n' + sharedReplyContract() + '\n\n' + buildConversationPrompt(profile, input);
    const caller = { model: localConfig.privateChatModel || localConfig.world?.model || (state.ai.model === 'default' ? undefined : state.ai.model),
      reasoningEffort: localConfig.privateChatReasoningEffort || state.ai.reasoningEffort };
    if (replySettings.mode === 'two-stage') {
      return await generateLifePlannedReply({ mode: 'conversation', prompt, input, caller, assertCurrent, profile, event, deadline, capabilityText });
    }
    const result = await backgroundTask(runtimeBudget.run({ purpose: 'life-conversation' }, async () => {
      await assertCurrent();
      const runner = createWorldModel({ directory: join(dataDir, 'life', 'conversation-model'), ...resolveReplyWriter(replySettings, caller),
        proxy: localConfig.codexProxy, schema: conversationDecisionSchema, timeoutMs: deadline - Date.now() });
      return runner({ prompt, signal: controller.signal });
    }));
    await assertCurrent(); return result.text;
  } finally { clearTimeout(timer); }
}

async function generateLifePlannedReply({ mode, prompt, input, caller, assertCurrent, profile, event, deadline = Infinity, capabilityText = '', creativeKinds = [] }) {
  const evidence = createReplyEvidence([{ kind: 'life-source', text: JSON.stringify(input), scope: input.scope }], { scope: input.scope });
  const context = { mode, creativeKinds, scope: input.scope, evidence, runtimeCapabilities: capabilityText, plainText: true, sources: input.sources,
    motiveRef: input.motiveRef, canDefer: input.canDefer === true, maxChars: mode === 'conversation' ? 300 : 900 };
  const result = await runReplyRole({ role: 'planner', prompt: prompt + '\n本轮原始资料编号：\n' + JSON.stringify(evidence) + '\n' + replyPlanPrompt(context),
    schema: replyPlanSchema(context), caller, event, assertCurrent, deadline });
  const plan = parseReplyPlan(result.text, context);
  let text = '';
  if (plan.utterance) {
    const writer = await runReplyRole({ role: 'writer', prompt: buildWriterPrompt({ ...context, profile, plan,
      current: mode === 'proactive' ? '这是主动联系，对方没有发来新消息。' : '这是对当前对象的活动暂离选择，不能预告已完成活动。' }),
      schema: writerReplySchema, caller, event, assertCurrent, deadline });
    text = parseWriterReply(writer.text, { maxChars: context.maxChars, requiredLiterals: plan.utterance.requiredLiterals }).text;
  }
  await assertCurrent(); return JSON.stringify(assembleReply(plan, text, context));
}

async function dispatchLifeConversation({ decisionId, scope, token, text, guard, epochToken }) {
  const event = lifeGenerationRoutes.get(decisionId);
  if (!event || !privateInputCurrent(event)) return { ok: false, reason: 'life-route-or-input-changed' };
  const result = await inReplyOrder(privateQueueKey(event), () => lifeContacts.sendIfCurrent(token, () => unifiedMemory.withEpoch(epochToken, () => {
    if (!personaCurrent() || serviceLifecycle?.stopping || !privateInputCurrent(event) || !isLifeContactEligible(event) || !guard()) return { ok: false, reason: 'life-choice-expired' };
    return dispatchPrivateSegments(event, [{ type: 'text', data: { text } }], { kind: 'outbound', intentId: `life-conversation:${decisionId}`, decisionId, epochToken });
  })));
  if (isPwaEvent(event)) { pwaActiveLogical.delete(event.pwaLogicalReplyId); await flushPwaProjections(); }
  lifeGenerationRoutes.delete(decisionId);
  return result;
}

async function dispatchLifeContact({ ticket, scope, guard, epochToken, noteRefs = [] }) {
  const event = lifeGenerationRoutes.get(ticket.id);
  if (!event || !privateInputCurrent(event)) return { ok: false, reason: 'life-route-or-input-changed' };
  event.learningSelectionMaterial = lifeGenerationSelections.get(ticket.id);
  const validateGeneration = lifeGenerationValidity.get(ticket.id);
  const generationCurrent = async () => { try { if (!personaCurrent() || !validateGeneration) return false; await validateGeneration(); return true; } catch { return false; } };
  const result = await inReplyOrder(privateQueueKey(event), () => lifeContacts.dispatch(ticket, text => unifiedMemory.withEpoch(epochToken, async () => {
    if (!await generationCurrent() || serviceLifecycle?.stopping || !isLifeContactEligible(event) || !guard()) return { ok: false, reason: 'life-choice-expired' };
    if (!await readingNotesCurrent(noteRefs, { scope, epochToken })) return { ok: false, reason: 'note-source-changed' };
    if (!await generationCurrent() || serviceLifecycle?.stopping || !isLifeContactEligible(event) || !guard()) return { ok: false, reason: 'life-choice-expired' };
    return dispatchPrivateSegments(event, [{ type: 'text', data: { text } }], { kind: 'outbound', intentId: ticket.id, epochToken });
  }), { guard: () => personaCurrent() && Boolean(validateGeneration) && !serviceLifecycle.stopping && isLifeContactEligible(event) && guard() }));
  discardCancelledWork(event, result?.reason);
  if (isPwaEvent(event)) { pwaActiveLogical.delete(event.pwaLogicalReplyId); await flushPwaProjections(); }
  lifeGenerationValidity.delete(ticket.id);
  lifeGenerationSelections.delete(ticket.id);
  lifeGenerationRoutes.delete(ticket.id);
  return result;
}

function isLifeReplyEligible(event) {
  return isLifeContactEligible(event);
}

async function resumeLifeReply(queuedEvent, { resumeContext, episodeId, markSending } = {}) {
  let event = refreshPrivateEvent({ ...queuedEvent, lifeResumeContext: [resumeContext,
    isPwaEvent(queuedEvent) ? '这是忙碌期间消息的一次合并回应。可按需查询一次原文后自然回应，最终只输出一条简短文字，不使用图片或表情附件。' : '这是忙碌期间消息的一次合并回应。可以只自然提一句当前情况；无需逐条回答。只输出一条简短文字，不使用图片、表情附件或补查标记。'
  ].filter(Boolean).join('\n') });
  if (!isLifeReplyEligible(event)) return { ok: false, reason: 'ineligible' };
  if (!await awaitPrivateProjection(memoryScope(event))) return { ok: false, reason: 'service-stopping' };
  if (!privateInputCurrent(event)) return { ok: false, reason: 'new-input-accepted' };
  if (!isCurrentLifeReply(event)) return { ok: false, reason: 'contact-stopped-or-stale' };
  if (!await unifiedMemory.isEpochCurrent(event.memoryEpochToken)) return { ok: false, reason: 'memory-epoch-changed' };
  if (!lifeContacts.canReplyIncoming(event.lifeIncomingTokens)) return { ok: false, reason: 'incoming-already-consumed-or-stale' };
  if (isPwaEvent(event)) {
    const rows = currentPwaImageInbox(pwaStore, event);
    event = await attachReplyContext({ ...event, pwaReplyRefs: rows.map(row => row.replyTo).filter(Boolean) });
    event = restorePwaBusyInput(rows, event);
  }
  event.lifeMarkSending = markSending;
  event.learningConversation = true;
  event.lifeReplyTicket = lifeConversation?.beginReply(event);
  const timing = createReplyTiming();
  const record = { id: crypto.randomUUID(), receivedAt: new Date().toISOString(), source: 'life-resume',
    episodeId, event, decision: { ok: true, status: '生成中' }, timings: timing, reply: null, send: null, error: null };
  state.privateChat.events.unshift(record); state.privateChat.events = state.privateChat.events.slice(0, 30);
  return replyTimingContext.run(timing, async () => {
    try {
      const reply = await buildModelReply(event);
      record.reply = stripImageAttachmentMarkers(reply).trim();
      if (!record.reply) {
        record.reply = '现在有空了，刚才的消息我看到了。';
        event.privateThought = null;
      }
      // Permissions may have changed while the model was running. Do not send
      // queued messages to a disabled channel or newly excluded contact.
      if (!isCurrentLifeReply(event)) return { ok: false, reason: 'contact-stopped-or-stale' };
      if (!lifeAvailable() || lifeTimeline.availability({ scope: memoryScope(event) }).busy) return { ok: false, reason: 'life-unavailable' };
      record.decision.status = '发送中';
      record.send = await measureSend(timing, () => inReplyOrder(privateQueueKey(event), async () =>
        sendRetrievalExpiryFallback(event, await sendCurrentPrivateSegments(event, [{ type: 'text', data: { text: record.reply } }], true))));
      if (event.retrievalFallbackText) record.reply = event.retrievalFallbackText;
      await finishPrivateIncoming(event, record.send);
      if (record.send?.ok) {
        const sentId = record.send.body?.data?.message_id;
        if (sentId != null) event.sentMessageIds = [String(sentId)];
        if (isPwaEvent(event)) { pwaActiveLogical.delete(event.pwaLogicalReplyId); await flushPwaProjections(); }
      }
      return { ok: record.send?.ok === true, uncertain: record.send?.uncertain === true || event.lifeDeliveryUncertain === true,
        reason: record.send?.reason, sentMessageIds: event.sentMessageIds || [] };
    } catch (error) {
      if (error.code === 'MEMORY_EPOCH_CHANGED') {
        record.reply = null;
        record.decision.reason = 'memory-epoch-changed';
        return { ok: false, reason: 'memory-epoch-changed', sentMessageIds: [] };
      }
      record.error = publicFailure(error);
      if (error.code === 'RUNTIME_BUDGET_BLOCKED' && !event.lifeTransportStarted && isCurrentLifeReply(event)
        && lifeAvailable() && !lifeTimeline.availability({ scope: memoryScope(event) }).busy) {
        // One local status response replaces the single failed catch-up attempt.
        // It is not a personal experience or a conversation-memory entry.
        record.reply = record.error;
        try {
          record.send = await measureSend(timing, () => inReplyOrder(privateQueueKey(event), () =>
            sendCurrentPrivateSegments(event, [{ type: 'text', data: { text: record.reply } }])));
        } catch { event.lifeDeliveryUncertain = event.lifeTransportStarted === true; }
      }
      return { ok: record.send?.ok === true, uncertain: event.lifeDeliveryUncertain === true,
        reason: record.send?.reason || 'reply-generation-or-send-failed', sentMessageIds: event.sentMessageIds || [] };
    } finally {
      await finishPrivateIncoming(event, record.send || { ok: false, uncertain: event.lifeDeliveryUncertain === true });
      pwaActiveLogical.delete(event.pwaLogicalReplyId);
      lifeConversation?.endReply(event.lifeReplyTicket);
      record.decision.status = record.send?.ok ? '已回复' : '回复失败';
      record.completedAt = new Date().toISOString();
      await saveReplyTiming(record);
    }
  });
}

async function processPrivateEvent(payload, context = {}) {
    const timing = createReplyTiming(payload.hubReceivedAt, payload.hubBatchCompletedAt, payload.hubQueueStartedAt);
    return replyTimingContext.run(timing, () => processTimedPrivateEvent(payload, timing, context));
}
async function processTimedPrivateEvent(payload, timing, context) {
    if (context?.channel !== 'pwa' || payload.group_id != null) return { ignored: true, reason: 'Private-only mode' };

    let event = normalizePrivateEvent(payload, context);
    if (!isPwaEvent(event)) event.pwaScopeGeneration = context.pwaScopeGeneration;
    if (!await awaitPrivateProjection(memoryScope(event))) return { status: 'ok', ignored: true, reason: 'service-stopping' };
    const durableTokens = context.lifeIncomingTokens || [];
    const durableById = new Map(durableTokens.map(token => [lifeContacts?.incomingMessageId(token), token]));
    const incomingToken = item => item.message_id == null && durableTokens.length === 1 ? durableTokens[0]
      : durableById.get(String(item.message_id));
    const trackedIncoming = Boolean(lifeContacts && durableTokens.length);
    // Check each original message. A retry of the first item must not discard
    // subsequent new messages gathered by the short batching window.
    let duplicate;
    if (payload.hubBatchMessages?.length) {
      // Only the internal turn coordinator may retain already-admitted inputs
      // when replacing an unsent draft. Callback fields cannot grant replay.
      const fresh = payload.hubBatchMessages.filter(item => trackedIncoming
        ? lifeContacts.canReplyIncoming([incomingToken(item)])
        : context.replyTurn?.admittedIds.has(String(item.message_id)) || !rememberEvent(getEventDedupeKey({ ...event, raw: item })));
      if (trackedIncoming) context.lifeIncomingTokens = fresh.map(incomingToken);
      context.replyTurn?.admit(fresh.map(item => item.message_id));
      duplicate = fresh.length === 0;
      if (!duplicate) {
        payload = { ...payload, message_id: fresh[0].message_id, hubBatchMessages: fresh,
          batched_message_ids: fresh.map(item => item.message_id),
          message: fresh.flatMap((item, index) => [...(index ? [{ type: 'text', data: { text: '\n' } }] : []), ...item.message]),
          raw_message: fresh.every(item => typeof item.raw_message === 'string') ? fresh.map(item => item.raw_message).join('\n') : undefined };
        event = normalizePrivateEvent(payload, context);
        if (!isPwaEvent(event)) event.pwaScopeGeneration = context.pwaScopeGeneration;
      }
    } else duplicate = trackedIncoming ? !lifeContacts.canReplyIncoming(durableTokens) : rememberEvent(getEventDedupeKey(event));
    if (duplicate) {
      const record = {
        id: crypto.randomUUID(),
        receivedAt: new Date().toISOString(),
        source: "pwa",
        event,
        decision: { ok: false, status: '忽略', reason: trackedIncoming && !lifeContacts.isCurrent(context.contactToken)
          ? 'contact-epoch-superseded' : 'Duplicate private message ignored' },
        timings: timing,
        completedAt: new Date().toISOString(),
        reply: null,
        error: null,
        send: null
      };
      state.privateChat.events.unshift(record);
      state.privateChat.events = state.privateChat.events.slice(0, 30);
      await saveReplyTiming(record);
      return ({ status: "ok", duplicate: true });
    }

    event.timings = timing;
    event.replyTurn = context.replyTurn;
    event.learningConversation = true;
    event.lifeContactToken = context.contactToken;
    event.lifeContactEvidence = context.contactEvidence;
    event.memoryEpochToken = context.memoryEpochToken;
    event.lifeIncomingTokens = context.lifeIncomingTokens || [];
    if (event.memoryEpochToken && !await unifiedMemory.isEpochCurrent(event.memoryEpochToken)) {
      await lifeContacts?.cancelIncoming(event.lifeIncomingTokens);
      return { status: 'ok', ignored: true, reason: 'memory-epoch-changed' };
    }
    const admission = shouldRespondToPrivate(event);
    const contactCurrent = !admission.ok || isCurrentLifeReply(event);
    if (!admission.ok || !contactCurrent) {
      const record = { id: crypto.randomUUID(), receivedAt: new Date(timing.receivedAt).toISOString(),
        source: 'pwa', event, decision: { ...admission, ok: false, status: '忽略',
          ...(!contactCurrent ? { reason: 'contact-epoch-superseded' } : {}) }, timings: timing,
        completedAt: new Date().toISOString(), reply: null, send: null, error: null };
      state.privateChat.events.unshift(record); state.privateChat.events = state.privateChat.events.slice(0, 30);
      await saveReplyTiming(record);
      return { status: 'ok', ignored: true };
    }
    if (lifeAvailable() && lifeReplies && event.backendCommand !== true) {
      try { await lifeTimeline.tick(); } catch (error) { suspendLife(error, { retryable: true }); }
      pumpLifeConversation();
      const disposition = lifeAvailable() ? await lifeReplies.receive(event).catch(error => { suspendLife(error); return { handled: false }; }) : { handled: false };
      if (disposition.handled) {
        const record = { id: crypto.randomUUID(), receivedAt: new Date(timing.receivedAt).toISOString(),
          source: 'pwa', event, decision: { ok: true, status: '生活消息已接收', reason: disposition.kind },
          timings: timing, completedAt: new Date().toISOString(), reply: null, send: null, error: null };
        state.privateChat.events.unshift(record); state.privateChat.events = state.privateChat.events.slice(0, 30);
        await saveReplyTiming(record);
        return { status: 'ok', life: disposition.kind };
      }
    }
    event.lifeReplyTicket = lifeAvailable() && event.backendCommand !== true ? lifeConversation?.beginReply(event) : undefined;
    try {
    await measurePreparation(timing, async () => {
      event = await attachReplyContext(event);
    });
    const decision = shouldRespondToPrivate(event);
    const record = { id: crypto.randomUUID(), receivedAt: new Date(timing.receivedAt).toISOString(),
      source: 'pwa', event, decision, timings: timing, reply: null, error: null, send: null };
    if (decision.ok) record.decision.status = '生成中';
    state.privateChat.events.unshift(record); state.privateChat.events = state.privateChat.events.slice(0, 30);
    let reply = null;
    let error = null;
    let commandAction = null;
    let modelReply = false;
    if (decision.ok) {
      try {
        commandAction = buildPrivateCommandAction(event);
        reply = await measurePreparation(timing, async () => {
          const prepared = decision.reply || await hubCommands.handle(event) || await privateTasks.handle(event) || commandAction?.reply || buildBoundaryReply(event);
          if (prepared) return prepared;
          if (!/^\s*\//.test(event.text || '')) event.replyTurn?.enableReplacement();
          throwIfReplySuperseded(event);
          const generated = await buildModelReply(event);
          modelReply = true;
          return generated;
        });
      } catch (caught) {
        if (caught.code === 'MEMORY_EPOCH_CHANGED') {
          record.reply = null;
          record.decision.status = '已取消';
          record.decision.reason = 'memory-epoch-changed';
          record.completedAt = new Date().toISOString();
          await lifeContacts?.cancelIncoming(event.lifeIncomingTokens);
          await saveReplyTiming(record);
          return { status: 'ok', ignored: true, reason: 'memory-epoch-changed' };
        }
        if (caught.code === 'REPLY_SUPERSEDED' || event.replyTurn?.signal.aborted) {
          discardCancelledWork(event, 'reply-superseded');
          record.decision.status = '已合并新消息';
          record.decision.reason = 'reply-superseded';
          record.completedAt = new Date().toISOString();
          await saveReplyTiming(record);
          return { status: 'ok', superseded: true };
        }
        error = publicFailure(caught);
        reply = caught.code === 'RUNTIME_BUDGET_BLOCKED' ? error : `这边刚刚卡了一下，等我再试一次。`;
      }
    }
    Object.assign(record, { reply, error });
    if (event.replyTurn?.signal.aborted) {
      record.reply = null;
      record.decision.status = '已合并新消息';
      record.decision.reason = 'reply-superseded';
      record.completedAt = new Date().toISOString();
      await saveReplyTiming(record);
      return { status: 'ok', superseded: true };
    }
    if (error && event.isOwner && event.type === 'private_message') record.reply = error;
    if (record.reply) record.decision.status = '发送中';
    if (record.reply && event.type === "private_message") {
      event.pwaSkipMemory = Boolean(error) || event.skipExchangeMemory === true;
      try {
        record.send = await measureSend(timing, () => sendPrivateReply(event, record.reply,
          { splitText: modelReply && !error && !/^\s*\//.test(event.text || '') }));
        if (event.retrievalFallbackText) record.reply = event.retrievalFallbackText;
      } catch (error) {
        record.send = { ok: false, uncertain: event.lifeDeliveryUncertain === true, error: error.message };
      }
    }
    // HTTP acceptance advances the durable generation before its asynchronous
    // contact projection reaches MessageBatches. If that barrier rejects an
    // entirely unpublished draft, retain its inputs for the newer PWA batch.
    // A changed identity/route, a command, or any published prefix is terminal;
    // none may be silently replayed as a fresh conversation.
    const unpublishedPwaReplacement = isPwaEvent(event) && event.backendCommand !== true
      && !event.sentMessageIds?.length
      && ['new-input-accepted', 'pwa-route-or-input-changed', 'delivery-stale', 'intake-pending'].includes(record.send?.reason)
      && pwaIdentityCurrent(event, pwaStore)
      && pwaStore.hasNewerPendingInbox({ userId: event.privateIdentity.userId,
        routeVersion: event.privateIdentity.routeVersion, generation: event.privateIdentity.generation });
    if (record.send?.reason === 'reply-superseded' || unpublishedPwaReplacement) {
      record.reply = null;
      record.decision.status = '已合并新消息';
      record.decision.reason = unpublishedPwaReplacement ? 'pwa-input-replaced-before-delivery' : 'reply-superseded';
      record.completedAt = new Date().toISOString();
      await saveReplyTiming(record);
      return { status: 'ok', superseded: true };
    }
    // A delivered prefix is the only reply that actually happened if a later
    // bubble failed or was superseded. Never remember unsent continuation text.
    if (record.send?.textComplete === false && record.send.deliveredText) {
      record.reply = record.send.deliveredText;
    }
    if (record.send?.reason === 'life-choice-replaced' && !event.lifeTransportStarted
      && !event.sentMessageIds?.length && isCurrentLifeReply(event) && lifeAvailable() && lifeReplies) {
      event.queueDisposition = await lifeReplies.defer(event);
      record.decision.reason = 'activity-transition-deferred';
    }
    if (record.reply && record.send?.ok !== false && commandAction?.afterSend) await commandAction.afterSend();
    if (isPwaEvent(event)) { pwaActiveLogical.delete(event.pwaLogicalReplyId); await flushPwaProjections(); }
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
    } finally {
      pwaActiveLogical.delete(event.pwaLogicalReplyId);
      lifeConversation?.endReply(event.lifeReplyTicket);
    }
}

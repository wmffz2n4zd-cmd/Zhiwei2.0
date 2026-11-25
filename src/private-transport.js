import { createHash } from 'node:crypto';
import { privateEventScope, privateScopeId } from './private-scope.js';
import { createPrivateIdentity } from './private-identity.js';

// These helpers are for server-created events only. Public request bodies must
// never be forwarded as either an event or its out-of-band identity context.
export const isPwaEvent = event => event?.channel === 'pwa';
export const privateQueueKey = event => `private:${privateEventScope(event)}`;
export const pwaSourceId = id => `pwa:${id}`;
export const pwaMessageId = id => String(id || '').replace(/^pwa:/, '');
export function privateInboundIds(event) {
  const ids = event.raw?.batched_message_ids || [event.raw?.message_id];
  return [...new Set(ids.filter(id => id != null).map(pwaMessageId))];
}
export function privateLogicalReplyId(event, kind = 'reply') {
  if (event.pwaLogicalReplyId) return event.pwaLogicalReplyId;
  const material = [privateEventScope(event), kind, privateInboundIds(event),
    event.lifeReplyEpisodeId || '', event.lifeStatusActivityId || '', event.privateIdentity?.routeVersion];
  return 'pwa-' + createHash('sha256').update(JSON.stringify(material)).digest('hex');
}
export function pwaPayloadForInbox(inbox) {
  const { message, identity } = inbox;
  if (!message?.id || !identity?.userId || !identity.memoryScope
    || message.userId != null && message.userId !== identity.userId) throw Error('Invalid durable PWA inbox');
  const participant = createPrivateIdentity(identity);
  const segments = [];
  if (message.replyTo) segments.push({ type: 'reply', data: { id: message.replyTo } });
  if (message.text) segments.push({ type: 'text', data: { text: message.text } });
  for (const id of message.mediaIds || []) segments.push({ type: 'image', data: { file: id } });
  return { type: 'private_message',
    senderId: privateScopeId(participant.memoryScope),
    message_id: pwaSourceId(message.id), message: segments,
    senderName: inbox.user?.displayName || inbox.user?.display_name || '对方' };
}
export function trustedPwaEvent(normalized, identity) {
  const participant = createPrivateIdentity(identity);
  const event = { ...normalized, channel: 'pwa', privateIdentity: structuredClone(participant),
    senderId: privateScopeId(participant.memoryScope), isOwner: participant.role === 'admin' };
  privateEventScope(event);
  return event;
}
export function pwaIdentityCurrent(event, store, { route = true, generation = false } = {}) {
  if (!isPwaEvent(event) || !store) return false;
  const identity = store.getIdentity(event.privateIdentity?.userId);
  return Boolean(identity && identity.enabled && identity.bindingStatus === 'active'
    && identity.memoryScope === event.privateIdentity?.memoryScope
    && (!route || identity.routeVersion === event.privateIdentity?.routeVersion)
    && (!generation || identity.generation === event.privateIdentity?.generation)
    && (event.isOwner !== true || identity.role === 'admin'));
}
export function projectionEvent(event, { includePrivateThought = false } = {}) {
  // Explicit whitelist: no functions, runtime handles, model prompts, session
  // credentials or arbitrary HTTP fields belong in the recovery material.
  const keys = ['channel', 'privateIdentity', 'type', 'senderId', 'senderName', 'senderLabel', 'text',
    'isOwner', 'backendCommand', 'memoryEpochToken', 'lifeContactToken', 'lifeIncomingTokens',
    'lifeStatusActivityId', 'lifeReplyEpisodeId', 'learningConversation', 'learningModelReply',
    'skipExchangeMemory', 'lifeBrowseIntent', 'pwaLogicalReplyId', 'pwaStatusReply'];
  const result = {};
  for (const key of keys) if (event[key] !== undefined) result[key] = structuredClone(event[key]);
  if (includePrivateThought && event.privateThought) result.privateThought = structuredClone(event.privateThought);
  result.raw = { message_id: event.raw?.message_id, batched_message_ids: event.raw?.batched_message_ids };
  if (event.replyMessageId) result.replyMessageId = event.replyMessageId;
  if (event.replyContext?.scopeVerified) result.replyContext = {
    scopeVerified: true, text: String(event.replyContext.text || '') };
  return result;
}

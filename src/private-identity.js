/** Private scopes are data identities, independent of administrator privileges.
 * Only authenticated server adapters may attach privateIdentity to an event.
 */
import { isPrivateScope } from './private-scope.js';
export { isPrivateScope } from './private-scope.js';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
export const isPrivateUserId = value => typeof value === 'string' && UUID.test(value);
export function createPrivateIdentity(value) {
  if (!value || !isPrivateUserId(value.userId) || !isPrivateScope(value.memoryScope)
    || !['friend', 'admin'].includes(value.role) || !Number.isSafeInteger(value.routeVersion) || value.routeVersion < 1
    || value.generation != null && (!Number.isSafeInteger(value.generation) || value.generation < 0)) {
    throw TypeError('Invalid private identity');
  }
  return Object.freeze({ userId: value.userId, memoryScope: value.memoryScope, role: value.role,
    routeVersion: value.routeVersion, generation: value.generation ?? 0,
    preferredChannel: value.preferredChannel || 'pwa', enabled: value.enabled !== false,
    bindingStatus: value.bindingStatus || 'active', status: value.bindingStatus || 'active', displayName: String(value.displayName || '').slice(0,80) });
}
export function isPwaPrivateEvent(event) {
  if (event?.channel !== 'pwa' || event.type !== 'private_message' || event.groupId != null || event.raw?.group_id != null) return false;
  try { const identity = createPrivateIdentity(event.privateIdentity); return identity.enabled && identity.bindingStatus === 'active'; }
  catch { return false; }
}
export function privateScopeFor(event) {
  if (event?.channel === 'pwa') {
    if (!isPwaPrivateEvent(event)) throw TypeError('Invalid PWA private participant');
    return event.privateIdentity.memoryScope;
  }
  // Channel-less stored facts retain their legacy scope. Retired transports
  // cannot construct a current participant or confer administrator access.
  if (event?.channel != null) throw TypeError('Unsupported private channel');
  const sender = event?.senderId;
  if (event?.type !== 'private_message' || event.groupId != null || event.raw?.group_id != null
    || !['string', 'number'].includes(typeof sender) || !/^[1-9]\d{0,127}$/.test(String(sender))) {
    throw TypeError('Invalid private participant');
  }
  return `qq:private:${sender}`;
}
export const privateParticipantKey = event => privateScopeFor(event);
export function privateMoodTopic(event) {
  const scope = privateScopeFor(event);
  return `mood:${scope.startsWith('qq:private:') ? scope.slice(11) : scope.slice(13)}`;
}

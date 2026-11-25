// These helpers consume authenticated internal events. HTTP bodies never become
// privateIdentity; each adapter constructs that context after authentication.
// The channel-less numeric form below is retained only for old stored facts
// and domain fixtures. It is not an ingress adapter or an authorization check.
export const isPrivateScope = value => typeof value === 'string' && value.length <= 160
  && /^(?:qq:private:[1-9]\d{0,127}|private:user:[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})$/.test(value);
export function privateEventScope(event) {
  if (event?.type !== 'private_message' || event.groupId != null || event.raw?.group_id != null)
    throw Error('A valid private participant is required');
  if (event.channel === 'pwa') {
    if (!event.privateIdentity?.userId || !isPrivateScope(event.privateIdentity.memoryScope))
      throw Error('A trusted PWA identity is required');
    return event.privateIdentity.memoryScope;
  }
  if (event.channel != null) throw Error('Unsupported private channel');
  const scope = `qq:private:${event.senderId}`;
  if (!isPrivateScope(scope)) throw Error('A valid legacy private participant is required');
  return scope;
}
export const privateScopeId = scope => isPrivateScope(scope) ? scope.replace(/^(?:qq:private:|private:user:)/, '') : null;

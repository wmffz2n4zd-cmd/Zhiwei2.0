// Explicit, independently reversible rollout controls. Unset writer overrides
// inherit the resolved caller pair, including world fallbacks for life calls.
export function privateReplySettings(config = {}) {
  const mode = config.privateReplyMode ?? 'single';
  if (!['single', 'two-stage'].includes(mode)) throw Error('Invalid privateReplyMode');
  const model = config.privateReplyWriterModel;
  const effort = config.privateReplyWriterReasoningEffort;
  if (model != null && (typeof model !== 'string' || !/^[A-Za-z0-9._:-]+$/.test(model))) throw Error('Invalid privateReplyWriterModel');
  if (effort != null && !['low', 'medium', 'high', 'xhigh', 'max', 'ultra'].includes(effort)) throw Error('Invalid privateReplyWriterReasoningEffort');
  if (model === 'gpt-6.1-terra' && effort !== 'medium') throw Error('T060 Terra writer requires explicit medium effort');
  const probability = config.privateReplyStyleProbability ?? 0;
  if (typeof probability !== 'number' || !Number.isFinite(probability) || probability < 0 || probability > 1) throw Error('Invalid privateReplyStyleProbability');
  if (config.privateReplyTranslationStyle != null && typeof config.privateReplyTranslationStyle !== 'boolean') throw Error('Invalid privateReplyTranslationStyle');
  const revision = config.personaRevision ?? null;
  if (revision !== null && (typeof revision !== 'string' || !/^[A-Za-z0-9._-]{1,80}$/.test(revision))) throw Error('Invalid personaRevision');
  return Object.freeze({ mode, writerModel: model ?? null, writerReasoningEffort: effort ?? null,
    styleProbability: probability, translationStyle: config.privateReplyTranslationStyle === true, personaRevision: revision });
}
export function resolveReplyWriter(settings, caller) {
  return { model: settings.writerModel || caller.model, reasoningEffort: settings.writerReasoningEffort || caller.reasoningEffort };
}

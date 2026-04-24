/**
 * Extract plain text from an LLM output event object.
 *
 * Checks three sources in order:
 *  1. `raw.response` — direct string response
 *  2. `raw.assistantTexts` — string array, joined together
 *  3. `raw.lastAssistant.content` — string or content-block array
 */
export function extractModelOutput(raw: Record<string, unknown>): string | undefined {
  const direct = raw.response;
  if (typeof direct === 'string' && direct.trim().length > 0) return direct;

  const assistantTexts = raw.assistantTexts;
  if (Array.isArray(assistantTexts) && assistantTexts.length > 0) {
    const joined = assistantTexts.filter((t): t is string => typeof t === 'string').join('');
    if (joined.trim().length > 0) return joined;
  }

  const last = raw.lastAssistant;
  if (last && typeof last === 'object') {
    const c = (last as { content?: unknown }).content;
    if (typeof c === 'string' && c.trim().length > 0) return c;
    if (Array.isArray(c)) {
      const parts: string[] = [];
      for (const block of c) {
        if (block && typeof block === 'object' && 'text' in block && typeof (block as { text?: string }).text === 'string') {
          parts.push((block as { text: string }).text);
        }
      }
      const s = parts.join('');
      if (s.trim().length > 0) return s;
    }
  }

  return undefined;
}

/**
 * Extract the messages array from an LLM input event context.
 *
 * Checks `messages`, `historyMessages`, `body.messages`, and `request.messages`.
 */
export function extractMessages(
  ctx: unknown,
): Array<{ role: string; content: unknown }> | undefined {
  const c = ctx as Record<string, unknown>;
  const asMsgs = (v: unknown): Array<{ role: string; content: unknown }> | undefined => {
    if (!Array.isArray(v) || v.length === 0) return undefined;
    return v as Array<{ role: string; content: unknown }>;
  };
  let m = asMsgs(c.messages);
  if (m) return m;
  m = asMsgs(c.historyMessages);
  if (m) return m;
  const body = c.body as Record<string, unknown> | undefined;
  if (body) {
    m = asMsgs(body.messages);
    if (m) return m;
  }
  const req = c.request as Record<string, unknown> | undefined;
  if (req) {
    m = asMsgs(req.messages);
    if (m) return m;
  }
  return undefined;
}

/**
 * Sanitize user message by stripping framework-injected metadata noise
 * before passing to Gatekeeper, so the reviewer model sees only the
 * actual user content.
 *
 * Two known noise patterns:
 *  1. [Supervisor] rules block (injected by this plugin via prependContext)
 *  2. Sender (untrusted metadata): ```json ... ``` block (injected by OpenClaw framework)
 */
export function sanitizeUserMessage(text: string): string {
  // 1. Remove [Supervisor] rules block (fixed format from STATIC_SUPERVISOR_RULES_BODY)
  let result = text.replace(
    /^\[Supervisor\] You are under dual-model supervision\.\s*Follow these rules:\s*\n(?:\s+- .+\n?)*\n*/,
    '',
  );
  // 2. Remove Sender (untrusted metadata): ```json ... ``` block
  result = result.replace(
    /^Sender \(untrusted metadata\):\s*\n```json\s*\n\{[\s\S]*?\}\s*\n```\s*\n*/,
    '',
  );
  return result.trim();
}

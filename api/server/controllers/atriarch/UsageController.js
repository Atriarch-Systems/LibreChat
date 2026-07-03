const { logger } = require('@librechat/data-schemas');

/**
 * Atriarch fork-only: proxy the signed-in user's Atriarch AI usage/plan summary to the chat UI.
 *
 * Kept self-contained under server/controllers/atriarch (+ server/routes/atriarch) so it never
 * conflicts on upstream merges. Reads the user's forwarded OIDC access token from the session —
 * the same source the custom-endpoint resolver uses (packages/api/src/atriarch/customEndpointAuth)
 * — and calls the Atriarch API GET /api/me/usage, then returns a compact, stable shape so the
 * client widget is insulated from upstream response changes.
 *
 * ATRIARCH_API_ORIGIN defaults to the public origin the pod already reaches for chat completions,
 * so no config change is required to ship; ops can point it at an in-cluster service later.
 */
const ATRIARCH_API_ORIGIN = (process.env.ATRIARCH_API_ORIGIN || 'https://ai.atriarch.systems').replace(
  /\/+$/,
  '',
);
const UPSTREAM_TIMEOUT_MS = 4000;

const getForwardedAccessToken = (req) =>
  req.user?.federatedTokens?.access_token || req.user?.openidTokens?.access_token;

const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);

async function usageController(req, res) {
  const accessToken = getForwardedAccessToken(req);
  if (!accessToken) {
    /** No forwarded OIDC access token (e.g. a non-openid session) — nothing to show; widget hides. */
    return res.status(204).end();
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), UPSTREAM_TIMEOUT_MS);
  try {
    const upstream = await fetch(`${ATRIARCH_API_ORIGIN}/api/me/usage`, {
      headers: { Authorization: `Bearer ${accessToken}`, Accept: 'application/json' },
      signal: controller.signal,
    });

    if (!upstream.ok) {
      /** 401 => the forwarded token was rejected; treat as "nothing to show" rather than an error. */
      if (upstream.status === 401) {
        return res.status(204).end();
      }
      logger.warn(`[atriarch/usage] upstream responded ${upstream.status}`);
      return res.status(502).json({ error: 'usage_unavailable' });
    }

    const u = await upstream.json();
    const plan = u.plan ?? {};
    const limits = u.usageLimits ?? {};
    const usageMonth = u.usageMonth ?? {};
    const remaining = u.remaining ?? {};

    return res.status(200).json({
      planCode: typeof plan.code === 'string' ? plan.code : null,
      allowsProModels: typeof plan.allowsProModels === 'boolean' ? plan.allowsProModels : null,
      monthlyTokenLimit:
        num(limits.tokenLimitOverride) ?? num(plan.monthlyTokenLimit) ?? num(limits.monthlyTokenLimit),
      monthlyTokensUsed: num(usageMonth.totalTokens) ?? num(usageMonth.TotalTokens),
      monthlyRequestLimit:
        num(limits.requestLimitOverride) ??
        num(plan.monthlyRequestLimit) ??
        num(limits.monthlyRequestLimit),
      monthlyRequestsUsed: num(usageMonth.requestCount) ?? num(usageMonth.RequestCount),
      tokensRemaining: num(remaining.tokens),
      requestsRemaining: num(remaining.requests),
      resetsAt: typeof u.resetsAt === 'string' ? u.resetsAt : null,
    });
  } catch (err) {
    logger.warn(`[atriarch/usage] fetch failed: ${err.message}`);
    return res.status(502).json({ error: 'usage_unavailable' });
  } finally {
    clearTimeout(timeout);
  }
}

module.exports = usageController;

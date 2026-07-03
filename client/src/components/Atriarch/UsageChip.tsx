import { memo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { request, apiBaseUrl } from 'librechat-data-provider';

/**
 * Atriarch fork-only: a compact plan/usage chip for the chat footer with a "View usage" link to
 * the account/billing page on the main site. Self-contained under components/Atriarch so it never
 * conflicts on upstream merges; the only upstream touch is a one-line mount in Chat/Footer.tsx.
 *
 * Data comes from the fork's server proxy GET /api/atriarch/usage (which forwards the user's OIDC
 * access token to the Atriarch API). It renders nothing but the link if usage is unavailable, so a
 * non-openid session or a transient upstream hiccup degrades gracefully.
 */

type UsageSummary = {
  planCode: string | null;
  allowsProModels: boolean | null;
  monthlyTokenLimit: number | null;
  monthlyTokensUsed: number | null;
  monthlyRequestLimit: number | null;
  monthlyRequestsUsed: number | null;
  tokensRemaining: number | null;
  requestsRemaining: number | null;
  resetsAt: string | null;
};

/** Usage/billing page on the main site (root-relative → resolves off /chat to the portal). */
const USAGE_PAGE_URL = '/billing';

const compact = (n: number): string => {
  if (n >= 1_000_000) {
    return `${(n / 1_000_000).toFixed(n % 1_000_000 === 0 ? 0 : 1)}M`;
  }
  if (n >= 1_000) {
    return `${Math.round(n / 1_000)}k`;
  }
  return `${n}`;
};

const planLabel = (code: string | null): string =>
  code ? code.charAt(0).toUpperCase() + code.slice(1) : 'Atriarch';

const ViewUsageLink = () => (
  <a className="underline" href={USAGE_PAGE_URL} target="_blank" rel="noreferrer">
    View usage
  </a>
);

function UsageChip() {
  const { data } = useQuery<UsageSummary | null>({
    queryKey: ['atriarch', 'usage'],
    queryFn: async () => (await request.get(`${apiBaseUrl()}/api/atriarch/usage`)) || null,
    staleTime: 60_000,
    refetchInterval: 5 * 60_000,
    refetchOnWindowFocus: true,
    retry: false,
  });

  if (!data || !data.planCode) {
    /** Nothing to summarize — still offer the link so users can reach their usage page. */
    return (
      <span className="inline-flex items-center gap-1 text-text-secondary">
        <ViewUsageLink />
      </span>
    );
  }

  const { monthlyTokensUsed: used, monthlyTokenLimit: limit } = data;
  const usageText =
    used != null && limit != null && limit > 0
      ? `${compact(used)}/${compact(limit)} tokens`
      : used != null
        ? `${compact(used)} tokens`
        : null;

  return (
    <span className="inline-flex items-center gap-1 text-text-secondary">
      <span className="font-medium">{planLabel(data.planCode)}</span>
      {usageText != null && (
        <>
          <span aria-hidden>·</span>
          <span>{usageText}</span>
        </>
      )}
      <span aria-hidden>·</span>
      <ViewUsageLink />
    </span>
  );
}

export default memo(UsageChip);

import type { TEndpoint } from 'librechat-data-provider';
import type { ServerRequest } from '~/types';
import { extractOpenIDTokenInfo } from '~/utils/oidc';

type AtriarchEndpointConfig = Partial<TEndpoint> & {
  atriarch?: {
    forwardUserAccessToken?: boolean;
  };
};

export function shouldForwardAtriarchUserAccessToken(endpointConfig: Partial<TEndpoint>): boolean {
  return (endpointConfig as AtriarchEndpointConfig).atriarch?.forwardUserAccessToken === true;
}

function getOpenIdAccessToken(req: ServerRequest): string | undefined {
  return extractOpenIDTokenInfo(req.user)?.accessToken;
}

export function resolveAtriarchCustomEndpointApiKey({
  endpoint,
  endpointConfig,
  req,
  configuredApiKey,
}: {
  endpoint: string;
  endpointConfig: Partial<TEndpoint>;
  req: ServerRequest;
  configuredApiKey?: string | null;
}): string {
  if (!shouldForwardAtriarchUserAccessToken(endpointConfig)) {
    return configuredApiKey ?? '';
  }

  if (req.user?.provider && req.user.provider !== 'openid') {
    throw new Error(
      `Atriarch endpoint ${endpoint} requires an OpenID access token; current user provider is ${req.user.provider}.`,
    );
  }

  const accessToken = getOpenIdAccessToken(req);
  if (!accessToken) {
    throw new Error(
      `Atriarch endpoint ${endpoint} requires req.user.federatedTokens.access_token or req.user.openidTokens.access_token; no forwarded OpenID access token was available.`,
    );
  }

  return accessToken;
}
import type { TEndpoint } from 'librechat-data-provider';
import type { ServerRequest } from '~/types';

type AtriarchEndpointConfig = Partial<TEndpoint> & {
  atriarch?: {
    forwardUserAccessToken?: boolean;
  };
};

type RequestWithOpenIdSession = ServerRequest & {
  session?: {
    openidTokens?: {
      accessToken?: string;
    };
  };
};

type UserWithTokenSet = NonNullable<ServerRequest['user']> & {
  tokenset?: {
    access_token?: string;
  };
};

export function shouldForwardAtriarchUserAccessToken(endpointConfig: Partial<TEndpoint>): boolean {
  return (endpointConfig as AtriarchEndpointConfig).atriarch?.forwardUserAccessToken === true;
}

function getOpenIdAccessToken(req: ServerRequest): string | undefined {
  const user = req.user as UserWithTokenSet | undefined;
  const session = req as RequestWithOpenIdSession;

  return (
    user?.federatedTokens?.access_token ||
    user?.openidTokens?.access_token ||
    session.session?.openidTokens?.accessToken ||
    user?.tokenset?.access_token
  );
}

export function resolveAtriarchCustomEndpointApiKey({
  endpoint,
  endpointConfig,
  req,
  fallbackApiKey,
}: {
  endpoint: string;
  endpointConfig: Partial<TEndpoint>;
  req: ServerRequest;
  fallbackApiKey?: string | null;
}): string {
  if (!shouldForwardAtriarchUserAccessToken(endpointConfig)) {
    return fallbackApiKey ?? '';
  }

  if (req.user?.provider && req.user.provider !== 'openid') {
    throw new Error(
      `Atriarch endpoint ${endpoint} requires an OpenID access token; current user provider is ${req.user.provider}.`,
    );
  }

  const accessToken = getOpenIdAccessToken(req);
  if (!accessToken) {
    throw new Error(
      `Atriarch endpoint ${endpoint} requires an OpenID access token, but none was available on the authenticated request.`,
    );
  }

  return accessToken;
}
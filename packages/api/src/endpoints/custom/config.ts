import { EModelEndpoint, extractEnvVariable, normalizeEndpointName } from 'librechat-data-provider';
import type { TCustomEndpoints, TEndpoint } from 'librechat-data-provider';
import type { TCustomEndpointsConfig } from '~/types/endpoints';
import { shouldForwardAtriarchUserAccessToken } from '~/atriarch/customEndpointAuth';
import { isUserProvided } from '~/utils';

/**
 * Load config endpoints from the cached configuration object
 * @param customEndpointsConfig - The configuration object
 */
export function loadCustomEndpointsConfig(
  customEndpoints?: TCustomEndpoints,
): TCustomEndpointsConfig | undefined {
  if (!customEndpoints) {
    return;
  }

  const customEndpointsConfig: TCustomEndpointsConfig = {};

  if (Array.isArray(customEndpoints)) {
    const filteredEndpoints = customEndpoints.filter(
      (endpoint) =>
        endpoint.baseURL &&
        // Atriarch fork: forwardUserAccessToken endpoints don't need a static
        // apiKey in config; the signed-in user's OpenID access token is used
        // per request. Treat that as a valid alternative to endpoint.apiKey
        // so the endpoint isn't filtered out at startup.
        (endpoint.apiKey || shouldForwardAtriarchUserAccessToken(endpoint)) &&
        endpoint.name &&
        endpoint.models &&
        (endpoint.models.fetch || endpoint.models.default),
    );

    for (let i = 0; i < filteredEndpoints.length; i++) {
      const endpoint = filteredEndpoints[i] as TEndpoint;
      const {
        baseURL,
        apiKey,
        name: configName,
        iconURL,
        modelDisplayLabel,
        customParams,
      } = endpoint;
      const name = normalizeEndpointName(configName);

      const resolvedApiKey = extractEnvVariable(apiKey ?? '');
      const resolvedBaseURL = extractEnvVariable(baseURL ?? '');
      const forwardsAtriarchUserAccessToken = shouldForwardAtriarchUserAccessToken(endpoint);

      customEndpointsConfig[name] = {
        type: EModelEndpoint.custom,
        // When the Atriarch fork forwards the user's OIDC access token, the
        // user does not need to provide their own key. Force userProvide=false
        // regardless of whether the placeholder apiKey value happens to match
        // the "user_provided" sentinel.
        userProvide: forwardsAtriarchUserAccessToken ? false : isUserProvided(resolvedApiKey),
        userProvideURL: isUserProvided(resolvedBaseURL),
        customParams,
        modelDisplayLabel,
        iconURL,
      };
    }
  }

  return customEndpointsConfig;
}

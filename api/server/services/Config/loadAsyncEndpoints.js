const { logger } = require('@librechat/data-schemas');
const { loadServiceKey, isUserProvided } = require('@librechat/api');
const { config } = require('./EndpointService');

async function loadAsyncEndpoints() {
  let serviceKey, googleUserProvides;
  const { googleKey } = config;

  /** Check if GOOGLE_KEY is provided at all(including 'user_provided') */
  const isGoogleKeyProvided = googleKey && googleKey.trim() !== '';

  if (isGoogleKeyProvided) {
    /** If GOOGLE_KEY is provided, check if it's user_provided */
    googleUserProvides = isUserProvided(googleKey);
  } else if (process.env.GOOGLE_SERVICE_KEY_FILE) {
    /**
     * Only probe for a Vertex AI service key when one is explicitly configured. Without this
     * guard, a deployment that uses neither GOOGLE_KEY nor a Vertex service account still
     * error-logs a missing default api/data/auth.json on every endpoints-config load.
     */
    try {
      serviceKey = await loadServiceKey(process.env.GOOGLE_SERVICE_KEY_FILE);
    } catch (error) {
      logger.error('Error loading service key', error);
      serviceKey = null;
    }
  }

  const google = serviceKey || isGoogleKeyProvided ? { userProvide: googleUserProvides } : false;

  return { google };
}

module.exports = loadAsyncEndpoints;

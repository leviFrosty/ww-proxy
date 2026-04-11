export const HERE_API = {
  GEOCODE_URL: 'https://geocode.search.hereapi.com/v1/geocode',
  AUTOCOMPLETE_URL: 'https://autocomplete.search.hereapi.com/v1/autocomplete',
  API_KEY_PARAM: 'apiKey',
} as const;

export const HTTP_STATUS = {
  OK: 200,
  NOT_FOUND: 404,
  TOO_MANY_REQUESTS: 429,
  INTERNAL_SERVER_ERROR: 500,
} as const;

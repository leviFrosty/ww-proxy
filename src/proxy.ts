import type { AppContext, ErrorResponse } from './types';
import { HERE_API, HTTP_STATUS } from './config';
import { ContentfulStatusCode } from 'hono/utils/http-status';
import { Sentry } from './sentry';

function extractQueryParameters(requestUrl: string): URLSearchParams {
  const url = new URL(requestUrl);
  return new URLSearchParams(url.search);
}

function sanitizeAndInjectApiKey(params: URLSearchParams, apiKey: string): URLSearchParams {
  params.delete(HERE_API.API_KEY_PARAM);
  params.set(HERE_API.API_KEY_PARAM, apiKey);
  return params;
}

function buildHereApiUrl(baseUrl: string, params: URLSearchParams): string {
  return `${baseUrl}?${params.toString()}`;
}

async function fetchFromHereApi(url: string): Promise<Response> {
  return fetch(url);
}

export async function proxyRequestToHereApi(context: AppContext, hereApiBaseUrl: string) {
  try {
    const queryParams = extractQueryParameters(context.req.url);
    const sanitizedParams = sanitizeAndInjectApiKey(queryParams, context.env.HERE_API_KEY);
    const hereApiUrl = buildHereApiUrl(hereApiBaseUrl, sanitizedParams);

    const hereApiResponse = await fetchFromHereApi(hereApiUrl);
    const responseData = await hereApiResponse.json();

    return context.json(responseData, hereApiResponse.status as ContentfulStatusCode);
  } catch (error) {
    Sentry.captureException(error);

    const errorResponse: ErrorResponse = { error: 'Proxy error' };
    return context.json(errorResponse, HTTP_STATUS.INTERNAL_SERVER_ERROR);
  }
}

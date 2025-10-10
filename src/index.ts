import { Hono } from "hono";
import type {
  Environment,
  AppContext,
  HealthCheckResponse,
  ErrorResponse,
} from "./types";
import { HERE_API, HTTP_STATUS } from "./config";
import { proxyRequestToHereApi } from "./proxy";
import { Sentry, createSentryConfig } from "./sentry";

const app = new Hono<{ Bindings: Environment }>();

async function handleGeocodeRequest(context: AppContext) {
  return proxyRequestToHereApi(context, HERE_API.GEOCODE_URL);
}

async function handleAutocompleteRequest(context: AppContext) {
  return proxyRequestToHereApi(context, HERE_API.AUTOCOMPLETE_URL);
}

function handleHealthCheckRequest(context: AppContext) {
  const response: HealthCheckResponse = {
    status: "ok",
    timestamp: new Date().toISOString(),
  };
  return context.json(response);
}

function handleNotFound(context: AppContext) {
  const response: ErrorResponse = { error: "Not found" };
  return context.json(response, HTTP_STATUS.NOT_FOUND);
}

function handleApplicationError(error: Error, context: AppContext) {
  Sentry.captureException(error);
  console.error("Application error:", error);

  const response: ErrorResponse = { error: "Internal server error" };
  return context.json(response, HTTP_STATUS.INTERNAL_SERVER_ERROR);
}

app.get("/geocode", handleGeocodeRequest);
app.get("/autocomplete", handleAutocompleteRequest);
app.get("/health", handleHealthCheckRequest);
app.notFound(handleNotFound);
app.onError(handleApplicationError);

export default Sentry.withSentry(
  (environment: Environment) => createSentryConfig(environment),
  {
    async fetch(
      request: Request,
      environment: Environment,
      context: ExecutionContext
    ): Promise<Response> {
      return app.fetch(request, environment, context);
    },
  } satisfies ExportedHandler<Environment>
);

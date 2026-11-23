import cookie from '@fastify/cookie';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import Fastify from 'fastify';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { ZodError } from 'zod';
import type { Settings } from '@attend/contracts';
import { loadEnv, allowedOrigins } from './env.ts';
import type { Env } from './env.ts';
import { createStores } from './db.ts';
import type { Stores } from './db.ts';
import { createKeyValue } from './lib/kv.ts';
import type { KeyValue } from './lib/kv.ts';
import { EventHub } from './lib/events.ts';
import { FaceService } from './services/face.ts';
import { ApiError, problemFor, PROBLEM_TYPE } from './lib/problem.ts';
import { CSRF_COOKIE, SESSION_COOKIE, loadPrincipal, safeEqual, touchSession } from './lib/auth.ts';
import type { Principal } from './lib/auth.ts';
import { loadSettings } from './lib/settings.ts';
import { registerAuthRoutes } from './routes/auth.ts';
import { registerDeviceRoutes } from './routes/devices.ts';
import { registerBiometricRoutes } from './routes/biometrics.ts';
import { registerCheckinRoutes } from './routes/checkin.ts';
import { registerSessionRoutes } from './routes/sessions.ts';
import { registerAttendanceRoutes } from './routes/attendance.ts';
import { registerReportRoutes } from './routes/reports.ts';
import { registerAdminRoutes } from './routes/admin.ts';
import { registerHealthRoutes } from './routes/health.ts';

declare module 'fastify' {
  interface FastifyInstance {
    env: Env;
    stores: Stores;
    kv: KeyValue;
    hub: EventHub;
    face: FaceService;
    settings(): Promise<Settings>;
    authenticate(request: FastifyRequest): Promise<Principal>;
  }
  interface FastifyRequest {
    principal: Principal | null;
  }
}

export interface AppOptions {
  env?: Env;
  /** Injected in tests so no network is touched. */
  face?: FaceService;
  kv?: KeyValue;
}

const UNSAFE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

export async function buildApp(options: AppOptions = {}): Promise<FastifyInstance> {
  const env = options.env ?? loadEnv();
  const stores = createStores(env);
  const kv = options.kv ?? createKeyValue(env.REDIS_URL);
  const face = options.face ?? new FaceService({
    url: env.FACE_SERVICE_URL,
    secret: env.FACE_SERVICE_SECRET,
    timeoutMs: env.FACE_SERVICE_TIMEOUT_MS,
  });

  const app = Fastify({
    logger: {
      level: env.LOG_LEVEL,
      // Never log request bodies: they can carry frames and assertions.
      redact: ['req.headers.authorization', 'req.headers.cookie', 'req.headers["x-service-token"]'],
      serializers: {
        req: (request) => ({ method: request.method, url: request.url, id: request.id }),
      },
    },
    trustProxy: true,
    bodyLimit: 12 * 1024 * 1024,
    disableRequestLogging: false,
  });

  app.decorate('env', env);
  app.decorate('stores', stores);
  app.decorate('kv', kv);
  app.decorate('hub', new EventHub(kv));
  app.decorate('face', face);
  app.decorate('settings', () => loadSettings(stores.db));
  app.decorateRequest('principal', null);

  await app.register(helmet, {
    contentSecurityPolicy: false, // the web app serves pages; the API returns JSON
    crossOriginResourcePolicy: { policy: 'same-site' },
  });

  await app.register(cors, {
    origin: allowedOrigins(env),
    credentials: true,
    methods: ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['content-type', 'x-csrf-token', 'idempotency-key'],
    exposedHeaders: ['x-request-id'],
  });

  await app.register(cookie, { secret: env.MASTER_KEY });

  await app.register(rateLimit, {
    global: true,
    max: 300,
    timeWindow: '1 minute',
    keyGenerator: (request) => request.principal?.userId ?? request.ip,
    errorResponseBuilder: () => {
      const error = new ApiError('RATE_LIMITED', 'Too many requests. Try again shortly.');
      return { statusCode: error.status, ...problemFor(error, '') };
    },
  });

  app.decorate('authenticate', async (request: FastifyRequest): Promise<Principal> => {
    if (request.principal) return request.principal;
    throw new ApiError('UNAUTHENTICATED', 'Sign in to continue.');
  });

  // Resolve the session once per request.
  app.addHook('onRequest', async (request) => {
    const token = request.cookies[SESSION_COOKIE];
    if (!token) return;
    const principal = await loadPrincipal(stores.db, token);
    if (principal) {
      request.principal = principal;
      // Sliding idle expiry, but only for real cookie sessions.
      if (principal.kind === 'web') {
        const settings = await loadSettings(stores.db);
        const idleMinutes = principal.requiresMfa
          ? settings.staffIdleMinutes
          : settings.studentIdleMinutes;
        await touchSession(stores.db, principal.sessionId, idleMinutes);
      }
    }
  });

  // CSRF: double-submit cookie for cookie-authenticated unsafe requests.
  app.addHook('preHandler', async (request, reply) => {
    if (!UNSAFE_METHODS.has(request.method)) return;
    if (!request.principal || request.principal.kind !== 'web') return;
    const header = request.headers['x-csrf-token'];
    const cookieValue = request.cookies[CSRF_COOKIE];
    if (typeof header !== 'string' || !cookieValue || !safeEqual(header, cookieValue)) {
      throw new ApiError('FORBIDDEN', 'CSRF token missing or invalid.');
    }
    void reply;
  });

  app.setErrorHandler((error, request, reply: FastifyReply) => {
    const instance = `${request.method} ${request.url}`;
    const requestId = request.id;

    if (error instanceof ApiError) {
      request.log.info({ code: error.code }, 'request rejected');
      void reply
        .status(error.status)
        .header('content-type', PROBLEM_TYPE)
        .send(problemFor(error, instance, requestId));
      return;
    }
    if (error instanceof ZodError) {
      const problem = problemFor(
        new ApiError(
          'VALIDATION_FAILED',
          'Request failed validation',
          error.issues.map((issue) => ({ path: issue.path.join('.'), message: issue.message })),
        ),
        instance,
        requestId,
      );
      request.log.info({ code: 'VALIDATION_FAILED' }, 'request failed validation');
      void reply.status(problem.status).header('content-type', PROBLEM_TYPE).send(problem);
      return;
    }
    if ((error as { statusCode?: number }).statusCode === 429) {
      const problem = problemFor(new ApiError('RATE_LIMITED'), instance, requestId);
      void reply.status(problem.status).header('content-type', PROBLEM_TYPE).send(problem);
      return;
    }

    request.log.error({ err: error }, 'unhandled error');
    const problem = problemFor(
      new ApiError('INTERNAL', 'An unexpected error occurred. Quote the request id when reporting it.'),
      instance,
      requestId,
    );
    void reply.status(problem.status).header('content-type', PROBLEM_TYPE).send(problem);
  });

  app.setNotFoundHandler((request, reply) => {
    const problem = problemFor(new ApiError('NOT_FOUND', `No route for ${request.url}`), `${request.method} ${request.url}`);
    void reply.status(404).header('content-type', PROBLEM_TYPE).send(problem);
  });

  // Route groups.
  await app.register(async (scope) => {
    await registerHealthRoutes(scope);
    await registerAuthRoutes(scope);
    await registerDeviceRoutes(scope);
    await registerBiometricRoutes(scope);
    await registerCheckinRoutes(scope);
    await registerSessionRoutes(scope);
    await registerAttendanceRoutes(scope);
    await registerReportRoutes(scope);
    await registerAdminRoutes(scope);
  });

  app.addHook('onClose', async () => {
    await app.hub.close();
    await kv.close();
    await stores.close();
  });

  return app;
}

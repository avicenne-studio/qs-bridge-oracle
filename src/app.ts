import path from "node:path";
import fastifyAutoload from "@fastify/autoload";
import { FastifyError, FastifyInstance, FastifyPluginOptions } from "fastify";
import { STATUS_CODES } from "node:http";

export const options = {
  ajv: {
    customOptions: {
      coerceTypes: "array",
      removeAdditional: "all",
    },
  },
};

export default async function serviceApp(
  fastify: FastifyInstance,
  opts: FastifyPluginOptions
) {
  delete opts.skipOverride; // This option only serves testing purpose
  // This loads all external plugins defined in plugins/infra
  // those should be registered first as your application plugins might depend on them
  await fastify.register(fastifyAutoload, {
    dir: path.join(import.meta.dirname, "plugins/infra"),
    options: {},
  });

  // This loads all your application plugins defined in plugins/app
  // those should be support plugins that are reused
  // through your application
  fastify.register(fastifyAutoload, {
    dir: path.join(import.meta.dirname, "plugins/app"),
    options: { ...opts },
  });

  // This loads all plugins defined in routes
  // define your routes in one of these
  fastify.register(fastifyAutoload, {
    dir: path.join(import.meta.dirname, "routes"),
    autoHooks: true,
    cascadeHooks: true,
    options: { ...opts },
  });

  fastify.setErrorHandler<FastifyError>((err, request, reply) => {
    fastify.log.error(
      {
        err,
        request: {
          method: request.method,
          url: request.url,
          query: request.query,
          params: request.params,
        },
      },
      "Unhandled error occurred"
    );

    const status = err.statusCode ?? 500;
    reply.code(status);

    let message = STATUS_CODES[status] /* c8 ignore next */ ?? "Unknown Error";

    if (status < 500 && err.message) {
      message = err.message;
    }

    return { message };
  });

  fastify.setNotFoundHandler(
    // An attacker could search for valid URLs if your 404 error handling is not rate limited.
    {
      preHandler: fastify.rateLimit({
        max: 3,
        timeWindow: 500,
      }),
    },
    (request, reply) => {
      request.log.warn(
        {
          request: {
            method: request.method,
            url: request.url,
            query: request.query,
            params: request.params,
          },
        },
        "Resource not found"
      );

      reply.code(404);

      return { message: "Not Found" };
    }
  );
}

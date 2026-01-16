import fastifyRateLimit from '@fastify/rate-limit'
import { FastifyInstance } from 'fastify'
import { EnvConfig, kEnvConfig } from './env.js'

export const autoConfig = (fastify: FastifyInstance) => {
  const config = fastify.getDecorator<EnvConfig>(kEnvConfig)
  return {
    max: config.RATE_LIMIT_MAX,
    timeWindow: '1 minute',
    global: true
  }
}

/**
 * This plugins is low overhead rate limiter for your routes.
 *
 * @see {@link https://github.com/fastify/fastify-rate-limit}
 */
export default fastifyRateLimit

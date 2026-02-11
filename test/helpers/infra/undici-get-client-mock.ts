import {
  type UndiciGetClient,
  type UndiciGetClientOptions,
  type UndiciGetClientService,
} from "../../../src/plugins/infra/undici-get-client.js";

// @ts-expect-error - Only used for testing purposes.
class MockUndiciGetClient implements UndiciGetClient {
  poolFor(): never {
    throw new Error("MockUndiciGetClient.poolFor not implemented");
  }

  async getJson<T>(): Promise<T> {
    throw new Error("MockUndiciGetClient.getJson not implemented");
  }

  async close(): Promise<void> {
    return;
  }
}

export function createMockUndiciGetClientService(): UndiciGetClientService {
  return {
    defaults: Object.freeze({
      connectionsPerOrigin: 1,
      pipelining: 1,
      headers: {},
      keepAliveTimeout: 10_000,
      keepAliveMaxTimeout: 60_000,
      connectTimeout: 5_000,
    }),
    create(_options?: UndiciGetClientOptions) {
      void _options;
      return new MockUndiciGetClient() as unknown as UndiciGetClient
    },
  };
}

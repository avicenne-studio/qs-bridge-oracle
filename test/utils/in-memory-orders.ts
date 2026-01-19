import { type OracleOrder } from "../../src/plugins/app/indexer/schemas/order.js";

export function createInMemoryOrders(initial: OracleOrder[] = []) {
  const store = new Map<string, OracleOrder>();
  for (const order of initial) {
    store.set(order.id, order);
  }

  return {
    store,
    async findById(id: string) {
      return store.get(id) ?? null;
    },
    async findBySourceNonce(sourceNonce: string) {
      for (const order of store.values()) {
        if (order.source_nonce === sourceNonce) {
          return order;
        }
      }
      return null;
    },
    async create(order: OracleOrder) {
      store.set(order.id, order);
      return order;
    },
    async update(id: string, changes: Partial<OracleOrder>) {
      const existing = store.get(id);
      if (!existing) {
        return null;
      }
      const updated = { ...existing, ...changes };
      store.set(id, updated);
      return updated;
    },
  };
}

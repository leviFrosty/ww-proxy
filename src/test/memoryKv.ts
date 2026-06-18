/** In-memory KV stand-in for tests. Implements the get/put/delete subset our
 * modules use; cast to the needed `Pick<KVNamespace, ...>` at the call site. */
export interface MemoryKv {
  get(key: string): Promise<string | null>
  put(key: string, value: string): Promise<void>
  delete(key: string): Promise<void>
  store: Map<string, string>
}

export const makeMemoryKv = (): MemoryKv => {
  const store = new Map<string, string>()
  return {
    store,
    get: async (key: string) => (store.has(key) ? store.get(key)! : null),
    put: async (key: string, value: string) => {
      store.set(key, value)
    },
    delete: async (key: string) => {
      store.delete(key)
    },
  }
}

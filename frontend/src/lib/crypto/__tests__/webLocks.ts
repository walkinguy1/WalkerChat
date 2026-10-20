const tails = new Map<string, Promise<void>>();

export const installWebLocks = () => {
  if (!globalThis.navigator) {
    Object.defineProperty(globalThis, 'navigator', { configurable: true, value: {} });
  }
  Object.defineProperty(navigator, 'locks', {
    configurable: true,
    value: {
      request: async <T>(_name: string, _options: { mode: 'exclusive' }, callback: () => Promise<T>) => {
        const name = _name;
        const previous = tails.get(name) ?? Promise.resolve();
        let release!: () => void;
        const current = new Promise<void>((resolve) => { release = resolve; });
        const tail = previous.then(() => current);
        tails.set(name, tail);
        await previous;
        try {
          return await callback();
        } finally {
          release();
          if (tails.get(name) === tail) tails.delete(name);
        }
      },
    },
  });
};

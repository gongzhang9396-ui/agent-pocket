import sodium from "libsodium-wrappers-sumo";

type KdfRequest = { id: number; password: string; salt: number[]; opsLimit: number; memLimit: number; algorithm: number };

self.addEventListener("message", (event: MessageEvent<KdfRequest>) => {
  const request = event.data;
  void (async () => {
    try {
      await sodium.ready;
      const key = sodium.crypto_pwhash(32, request.password, new Uint8Array(request.salt), request.opsLimit, request.memLimit, request.algorithm);
      const result = Array.from(key);
      sodium.memzero(key);
      self.postMessage({ id: request.id, result });
    } catch (error) {
      self.postMessage({ id: request.id, error: error instanceof Error ? error.message : String(error) });
    }
  })();
});

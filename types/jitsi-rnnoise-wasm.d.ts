declare module "@jitsi/rnnoise-wasm/dist/rnnoise-sync.js" {
  function createRNNWasmModuleSync(): {
    ready: Promise<unknown>;
    _malloc: (size: number) => number;
    _free: (ptr: number) => void;
    _rnnoise_create: () => number;
    _rnnoise_destroy: (ctx: number) => void;
    _rnnoise_process_frame: (ctx: number, input: number, output: number) => number;
    HEAPF32: Float32Array;
  };
  export default createRNNWasmModuleSync;
  export { createRNNWasmModuleSync };
}

declare module "@jitsi/rnnoise-wasm" {
  export function createRNNWasmModuleSync(): {
    ready: Promise<unknown>;
    _malloc: (size: number) => number;
    _free: (ptr: number) => void;
    _rnnoise_create: () => number;
    _rnnoise_destroy: (ctx: number) => void;
    _rnnoise_process_frame: (ctx: number, input: number, output: number) => number;
    HEAPF32: Float32Array;
  };
  export function createRNNWasmModule(): Promise<unknown>;
}

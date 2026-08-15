declare module './jabcodeModule.js' {
  type JabModuleFactory = (overrides?: Record<string, unknown>) => Promise<{
    ccall: (name: string, returnType: string, argTypes: string[], args: unknown[]) => unknown;
    _free: (ptr: number) => void;
    _malloc: (size: number) => number;
    HEAPU8: Uint8Array;
    HEAP32: Int32Array;
  }>;
  const createJabcodeModule: JabModuleFactory;
  export default createJabcodeModule;
}

declare module '*/jabcodeModule.js' {
  type JabModuleFactory = (overrides?: Record<string, unknown>) => Promise<{
    ccall: (name: string, returnType: string, argTypes: string[], args: unknown[]) => unknown;
    _free: (ptr: number) => void;
    _malloc: (size: number) => number;
    HEAPU8: Uint8Array;
    HEAP32: Int32Array;
  }>;
  const createJabcodeModule: JabModuleFactory;
  export default createJabcodeModule;
}

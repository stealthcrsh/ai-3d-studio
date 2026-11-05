declare module 'gltf-validator' {
  const validator: {
    version(): string;
    validateBytes(bytes: Uint8Array, options?: { maxIssues?: number }): Promise<{ issues: unknown }>;
  };
  export default validator;
}

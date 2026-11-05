declare module 'gltf-validator' {
  export function version(): string;
  export function validateBytes(bytes: Uint8Array, options?: { maxIssues?: number }): Promise<{ issues: unknown }>;
}

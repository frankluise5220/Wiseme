/**
 * Next.js instrumentation entry (see node_modules/next/dist/docs for the API).
 * `register` runs once when a server instance starts; runtime-specific code is
 * imported conditionally so edge builds do not pull in Node-only modules.
 */
export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    await import("./instrumentation-node");
  }
}

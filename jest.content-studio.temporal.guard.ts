// Test infrastructure only. The Content Studio Temporal integration suite
// (P8-C2) may only ever reach the disposable local Temporal dev server made
// for it, never the long-lived local stack (port 7233) or any other server.
// In memory, gone with the container:
//
//   docker run --name postiz-content-studio-p8c2-temporal --rm \
//     -p 127.0.0.1:57233:7233 --entrypoint temporal \
//     temporalio/admin-tools:1.28.1-tctl-1.18.4-cli-1.4.1 \
//     server start-dev --ip 0.0.0.0 --headless
//
// The address comes from CONTENT_STUDIO_TEMPORAL_INTEGRATION_ADDRESS only and
// is checked before any connection exists. Errors never repeat the address
// that was given
export const CONTENT_STUDIO_TEMPORAL_ADDRESS_ENV =
  'CONTENT_STUDIO_TEMPORAL_INTEGRATION_ADDRESS';

// exactly the address the container is published on: no name to resolve
export const CONTENT_STUDIO_TEMPORAL_ADDRESS = '127.0.0.1:57233';

export class ContentStudioTemporalSafetyError extends Error {
  constructor(reason: string) {
    super(`Refusing the Content Studio Temporal integration server: ${reason}`);
    this.name = 'ContentStudioTemporalSafetyError';
  }
}

export function contentStudioTemporalAddressFromEnv(
  env: NodeJS.ProcessEnv = process.env
): string {
  const raw = env[CONTENT_STUDIO_TEMPORAL_ADDRESS_ENV];
  if (!raw) {
    throw new ContentStudioTemporalSafetyError(
      `${CONTENT_STUDIO_TEMPORAL_ADDRESS_ENV} is required for the isolated Content Studio Temporal integration suite`
    );
  }
  if (raw !== CONTENT_STUDIO_TEMPORAL_ADDRESS) {
    throw new ContentStudioTemporalSafetyError(
      `the address is not ${CONTENT_STUDIO_TEMPORAL_ADDRESS}`
    );
  }
  // the orchestrator's Temporal module reads TEMPORAL_ADDRESS: it may only
  // name the same server, and no other connection setting may be set
  if (env.TEMPORAL_ADDRESS !== undefined && env.TEMPORAL_ADDRESS !== raw) {
    throw new ContentStudioTemporalSafetyError(
      'TEMPORAL_ADDRESS is set to another server'
    );
  }
  for (const name of ['TEMPORAL_TLS', 'TEMPORAL_API_KEY']) {
    if (env[name]) {
      throw new ContentStudioTemporalSafetyError(`${name} is set`);
    }
  }
  if (
    env.TEMPORAL_NAMESPACE !== undefined &&
    env.TEMPORAL_NAMESPACE !== 'default'
  ) {
    throw new ContentStudioTemporalSafetyError(
      'TEMPORAL_NAMESPACE is set to another namespace'
    );
  }
  return raw;
}

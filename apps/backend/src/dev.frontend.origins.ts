// The frontend dev server answers on localhost, 127.0.0.1 and the hostnames
// in POSTIZ_ALLOWED_DEV_ORIGINS (see next.config.js). Only in development
// (NODE_ENV=development, as scripts/content-studio-dev-db.sh runs the
// backend) and only when that is set (a LAN dev setup) is each of them also
// an allowed origin, on the protocol and port of FRONTEND_URL. Anything else
// changes nothing, an unset NODE_ENV included: the image does not set it
export const devFrontendOrigins = (env: NodeJS.ProcessEnv = process.env) => {
  if (env.NODE_ENV !== 'development') {
    return [];
  }
  const hosts = (env.POSTIZ_ALLOWED_DEV_ORIGINS ?? '')
    .split(',')
    .map((entry) => entry.trim().toLowerCase())
    .filter((entry) => /^[a-z0-9.-]+$/.test(entry));
  if (!hosts.length) {
    return [];
  }
  try {
    const frontend = new URL(env.FRONTEND_URL!);
    return [...new Set(['localhost', '127.0.0.1', ...hosts])].map((host) => {
      const origin = new URL(frontend.origin);
      origin.hostname = host;
      return origin.origin;
    });
  } catch {
    // no valid FRONTEND_URL: the configuration check reports it
    return [];
  }
};

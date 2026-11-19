// The base is the directory containing assets/, not assets/ itself.
export function assetBaseURL(config, manifestURL) {
  const configured = config?.assetBaseUrl;
  if (configured !== undefined && typeof configured !== 'string') {
    throw new Error('assetBaseUrl must be a URL string.');
  }
  if (!configured?.trim()) return new URL('.', manifestURL);
  const url = new URL(configured.trim());
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) {
    throw new Error('assetBaseUrl must be a public HTTPS directory URL without credentials, query, or fragment.');
  }
  if (!url.pathname.endsWith('/')) url.pathname += '/';
  return url;
}

export function resolveAssetURL(src, base) {
  if (typeof src !== 'string' || !src) throw new Error('Missing asset source.');
  const url = new URL(src, base);
  if (!['http:', 'https:'].includes(url.protocol) || url.origin !== base.origin || !url.pathname.startsWith(base.pathname)) {
    throw new Error('Asset must be inside the configured asset directory.');
  }
  return url.href;
}

import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  serverExternalPackages: ['postgres'],
  poweredByHeader: false,
  experimental: { serverActions: { bodySizeLimit: '2mb' } },
};

export default nextConfig;

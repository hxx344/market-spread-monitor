import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  typescript: {
    tsconfigPath: "tsconfig.linux.json",
  },
  experimental: {
    webpackMemoryOptimizations: true,
  },
};

export default nextConfig;

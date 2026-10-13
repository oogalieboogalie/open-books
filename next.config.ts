import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // The Docker image runs the self-contained server that standalone output produces.
  output: process.env.BUILD_STANDALONE === "1" ? "standalone" : undefined,
  serverExternalPackages: ["@electric-sql/pglite", "pg"],
};

export default nextConfig;

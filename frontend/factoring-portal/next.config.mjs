/** @type {import('next').NextConfig} */
const nextConfig = {
  output: "standalone",
  transpilePackages: ["@agent-studio/contracts"],
};

export default nextConfig;

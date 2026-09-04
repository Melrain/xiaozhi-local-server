import type { NextConfig } from "next";

const advertiseHost = process.env.ADVERTISE_HOST?.trim() || "192.168.50.188";

const nextConfig: NextConfig = {
  allowedDevOrigins: [advertiseHost, "127.0.0.1", "localhost"],
  logging: {
    incomingRequests: {
      ignore: [/\/api\/status/],
    },
  },
};

export default nextConfig;

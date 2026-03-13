import { createTRPCProxyClient, httpBatchLink } from "@trpc/client";
import { type AppRouter } from "../../server/src/server/api/root";
import superjson from "superjson";

const getUrl = () => {
  let url = process.env.BACKEND_URL || "http://localhost:3001";
  
  // Ensure the URL has a protocol
  if (!url.startsWith("http://") && !url.startsWith("https://")) {
    url = `https://${url}`;
  }

  // Remove trailing slash if present
  if (url.endsWith("/")) {
    url = url.slice(0, -1);
  }

  // Ensure it doesn't already end with /api/trpc before appending it
  if (!url.endsWith("/api/trpc")) {
    url = `${url}/api/trpc`;
  }
  
  return url;
};

export const trpc = createTRPCProxyClient<AppRouter>({
  transformer: superjson,
  links: [
    httpBatchLink({
      url: getUrl(),
    }),
  ],
});

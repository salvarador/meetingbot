import { createTRPCProxyClient, httpBatchLink } from "@trpc/client";
import { type AppRouter } from "../../server/src/server/api/root";
import superjson from "superjson";

const getUrl = () => {
  let url = process.env.BACKEND_URL || "http://localhost:3001/api/trpc";
  
  // Ensure the URL has a protocol
  if (!url.startsWith("http://") && !url.startsWith("https://")) {
    url = `https://${url}`;
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

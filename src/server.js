import { createApp } from "./app.js";

const host = process.env.HOST || "0.0.0.0";
const port = Number(process.env.PORT || 8787);

const app = await createApp();

try {
  await app.listen({ host, port });
  console.log(`API: http://127.0.0.1:${port}`);
  console.log(`Health: http://127.0.0.1:${port}/v1/health`);
} catch (error) {
  app.log.error(error);
  process.exit(1);
}

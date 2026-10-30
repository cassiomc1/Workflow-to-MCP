import { startDemo } from "./server.js";
const demo = await startDemo(Number(process.env.DEMO_PORT ?? 4173));
process.stdout.write(`Synthetic demo: ${demo.origin}/tickets\n`);
for (const signal of ["SIGINT", "SIGTERM"] as const)
  process.once(signal, () => {
    void demo.close();
  });

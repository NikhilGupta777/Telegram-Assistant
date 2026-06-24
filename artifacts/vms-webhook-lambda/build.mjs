import path from "node:path";
import { fileURLToPath } from "node:url";
import { build as esbuild } from "esbuild";
import { rm } from "node:fs/promises";

const dir = path.dirname(fileURLToPath(import.meta.url));

async function buildAll() {
  const distDir = path.resolve(dir, "dist");
  await rm(distDir, { recursive: true, force: true });

  await esbuild({
    entryPoints: [path.resolve(dir, "src/index.ts")],
    platform: "node",
    target: "node22",
    bundle: true,
    format: "esm",
    outfile: path.resolve(distDir, "index.mjs"),
    logLevel: "info",
    sourcemap: "linked",
    // The AWS SDK v3 is provided by the Lambda Node.js runtime — don't bundle it.
    // pg-native is an optional native binding pg loads lazily; keep it external.
    external: ["@aws-sdk/*", "*.node", "pg-native"],
    banner: {
      js: `import { createRequire as __cr } from 'node:module';
import __url from 'node:url';
import __path from 'node:path';
globalThis.require = __cr(import.meta.url);
globalThis.__filename = __url.fileURLToPath(import.meta.url);
globalThis.__dirname = __path.dirname(globalThis.__filename);`,
    },
  });
}

buildAll().catch((err) => {
  console.error(err);
  process.exit(1);
});

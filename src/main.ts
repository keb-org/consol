#!/usr/bin/env bun
import { main } from "./cli/main";

export * from "./cli/main";

if (import.meta.main) {
  main().catch((e) => {
    console.error(e?.stack ?? String(e));
    process.exit(1);
  });
}


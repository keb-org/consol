#!/usr/bin/env bun
import { main } from "../src/main.ts";

main().catch((e) => {
  console.error(e?.stack ?? String(e));
  process.exit(1);
});

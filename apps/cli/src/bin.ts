#!/usr/bin/env node
import { runCli } from "./commands/index.js";

process.exitCode = await runCli(process.argv.slice(2));

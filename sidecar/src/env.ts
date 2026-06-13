// Loaded as the FIRST import everywhere so dotenv populates process.env before
// any module reads it at import time (config.ts wallets, settle.ts keys, ...).
import { config } from "dotenv";
config({ path: new URL("../../.env", import.meta.url) });

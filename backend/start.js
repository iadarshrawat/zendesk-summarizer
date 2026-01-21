process.env.NODE_NO_WASM = "1";
process.env.NODE_OPTIONS = "--no-wasm";

import("./server.js");

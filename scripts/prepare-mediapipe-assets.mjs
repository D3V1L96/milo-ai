import { copyFile, mkdir } from "node:fs/promises";

const source = new URL("../node_modules/@mediapipe/tasks-vision/wasm/", import.meta.url);
const destination = new URL("../public/mediapipe/wasm/", import.meta.url);
await mkdir(destination, { recursive: true });
await Promise.all(["vision_wasm_internal.js", "vision_wasm_internal.wasm"].map((file) =>
  copyFile(new URL(file, source), new URL(file, destination))
));

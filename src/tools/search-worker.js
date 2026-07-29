import { parentPort } from "node:worker_threads";

parentPort.on("message", ({ pattern, lines }) => {
  try {
    const regex = new RegExp(pattern, "g");
    const matches = [];
    for (let index = 0; index < lines.length; index += 1) {
      regex.lastIndex = 0;
      if (regex.test(lines[index])) matches.push(index);
    }
    parentPort.postMessage({ matches });
  } catch (error) {
    parentPort.postMessage({ error: error.message });
  }
});

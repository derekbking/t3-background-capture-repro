import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

const here = path.dirname(fileURLToPath(import.meta.url));
if (!process.argv[2]) throw new Error("Usage: node prepare.mjs /path/to/t3code [output-directory]");
const sourceRoot = fs.realpathSync(process.argv[2]);
const lab = path.resolve(process.argv[3] ?? path.join(here, "prepared"));
const expected = "7aaff447496ef8fdc3889dde9801ec3db8417754";
const head = execFileSync("git", ["-C", sourceRoot, "rev-parse", "HEAD"], {encoding:"utf8"}).trim();
if (head !== expected) throw new Error(`Expected ${expected}; got ${head}`);
const hostPath = path.join(sourceRoot, "apps/desktop/src/preview/DesktopBrowserHost.ts");
const current = fs.readFileSync(hostPath, "utf8");
const before = "                        await webContents.capturePage(undefined, {\n                          stayHidden: true,\n                          stayAwake: false,\n                        });\n                        requireCurrent(signal);\n                        if (!screenshotSettled) {\n                          await webContents.capturePage(undefined, {\n                            stayHidden: true,\n                            stayAwake: false,\n                          });\n                        }";
const after = "                        do {\n                          const copy = await webContents.capturePage(undefined, {\n                            stayHidden: true,\n                            stayAwake: false,\n                          });\n                          requireCurrent(signal);\n                          if (copy.isEmpty()) break;\n                        } while (!screenshotSettled);";
if (!current.includes(before)) throw new Error("Capture implementation no longer matches the tested source");
const adaptive = current.replace(before, after)
  .replace('from "./CdpRelay.ts"', "from " + JSON.stringify(path.join(sourceRoot, "apps/desktop/src/preview/CdpRelay.ts")))
  .replace('from "./Manager.ts"', "from " + JSON.stringify(path.join(sourceRoot, "apps/desktop/src/preview/Manager.ts")));
// Refuse to overwrite an existing directory. No installed app or source files are changed.
fs.mkdirSync(lab);
const runner = fs.readFileSync(path.join(here, "run.template.ts"), "utf8").replace(/'(__T3_SOURCE__[^']*|__LAB__)'/g, (_, value) => JSON.stringify(value.replace("__T3_SOURCE__", sourceRoot).replace("__LAB__", lab)));
fs.writeFileSync(path.join(lab, "run.ts"), runner);
fs.writeFileSync(path.join(lab, "AdaptiveHost.ts"), adaptive);
for (const name of ["fixture.html", "window.html", "vite.config.ts"]) fs.copyFileSync(path.join(here, name), path.join(lab, name));
fs.symlinkSync(path.join(sourceRoot, "apps/desktop/node_modules"), path.join(lab, "node_modules"), "dir");
console.log(lab);

import { randomBytes } from "node:crypto";
import { constants, copyFileSync, linkSync, mkdirSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";

/** Write via a temp file in the same directory, then rename over the target. */
export function writeFileAtomic(file: string, text: string): void {
  const dir = dirname(file);
  mkdirSync(dir, { recursive: true });
  const tmp = join(dir, `.${basename(file)}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`);
  try {
    writeFileSync(tmp, text);
    renameSync(tmp, file);
  } catch (error) {
    try {
      unlinkSync(tmp);
    } catch {}
    throw error;
  }
}

/** Move a file without replacing an existing target. Throws `EEXIST` if the target exists. */
export function moveNoReplace(source: string, target: string): void {
  mkdirSync(dirname(target), { recursive: true });
  try {
    linkSync(source, target);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EXDEV") throw error;
    copyFileSync(source, target, constants.COPYFILE_EXCL);
  }
  unlinkSync(source);
}

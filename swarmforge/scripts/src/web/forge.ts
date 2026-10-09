// Port of forge.bb: multi-project forge (packs/, projects/, open-projects).

import { copyFileSync, cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { run, spawnBackground } from "../core/proc.ts";
import { isBlank, javaSplit, notEmpty, splitLines } from "../core/text.ts";
import { HttpError } from "./http-error.ts";

export const packNames = ["two-pack", "four-pack", "six-pack"];
const sharedArticles = ["engineering.prompt", "workflow.prompt", "handoffs.prompt"];

function isDir(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

export const isForge = (root: string | undefined): root is string => !!root && isDir(join(root, "projects"));
const packsDir = (root: string): string => join(root, "packs");
const projectsDir = (root: string): string => join(root, "projects");
const packDir = (root: string, pack: string): string => join(packsDir(root), pack);
export const projectDir = (root: string, name: string): string => join(projectsDir(root), name);

function stripGithub(text: string): string {
  return text.replace(/\.git$/, "").replace(/^https?:\/\/github.com\//, "").replace(/^git@github.com:/, "");
}

export function inferredName(input: string | undefined, github = false): string {
  const trimmed = (input ?? "").trim();
  if (!github) return trimmed;
  const stripped = stripGithub(trimmed);
  return javaSplit(stripped, "/").at(-1) ?? stripped;
}

export function githubCloneUrl(name: string): string {
  const base = (notEmpty(process.env.SWARMFORGE_GITHUB_BASE) ?? "https://github.com/").replace(/\/+$/, "");
  const repo = stripGithub(name.trim());
  return base.startsWith("http") ? `${base}/${repo}.git` : join(base, repo);
}

function sortedDirs(dir: string): string[] {
  try {
    return readdirSync(dir).filter((name) => isDir(join(dir, name))).sort();
  } catch {
    return [];
  }
}

export function listPackNames(root: string): string[] {
  return sortedDirs(packsDir(root)).filter((name) => isFile(join(packsDir(root), name, "swarmforge", "swarmforge.conf")));
}

export function packConf(root: string, pack: string): string | undefined {
  const file = join(packDir(root, pack), "swarmforge", "swarmforge.conf");
  return isFile(file) ? readFileSync(file, "utf8") : undefined;
}

export function listProjectNames(root: string): string[] {
  return sortedDirs(projectsDir(root)).filter((name) => !name.startsWith("."));
}

const openProjectsFile = (root: string): string => join(root, ".swarmforge", "open-projects");

export function readOpenProjects(root: string): string[] {
  const file = openProjectsFile(root);
  if (!isFile(file)) return [];
  return splitLines(readFileSync(file, "utf8")).map((line) => line.trim()).filter((line) => line !== "");
}

function writeOpenProjects(root: string, names: string[]): void {
  const file = openProjectsFile(root);
  mkdirSync(join(root, ".swarmforge"), { recursive: true });
  writeFileSync(file, names.map((name) => `${name}\n`).join(""));
}

const projectOpen = (root: string, name: string): boolean => readOpenProjects(root).includes(name);
const markOpen = (root: string, name: string): void => writeOpenProjects(root, [...new Set([...readOpenProjects(root), name])]);
const markClosed = (root: string, name: string): void =>
  writeOpenProjects(root, readOpenProjects(root).filter((n) => n !== name));

const packNameFile = (project: string): string => join(project, ".swarmforge", "pack");

function storedPack(project: string): string | undefined {
  const file = packNameFile(project);
  return isFile(file) ? readFileSync(file, "utf8").trim() : undefined;
}

function writePackName(project: string, pack: string): void {
  mkdirSync(join(project, ".swarmforge"), { recursive: true });
  writeFileSync(packNameFile(project), `${pack}\n`);
}

function copyTreeReplace(src: string, dest: string): void {
  rmSync(dest, { recursive: true, force: true });
  mkdirSync(join(dest, ".."), { recursive: true });
  cpSync(src, dest, { recursive: true });
}

function copySharedScripts(forge: string, dest: string): void {
  const src = join(forge, "swarmforge", "scripts");
  if (!isDir(src)) throw new HttpError(500, `Missing host scripts at ${src}`);
  copyTreeReplace(src, join(dest, "swarmforge", "scripts"));
}

function copySharedArticles(forge: string, dest: string): void {
  for (const name of sharedArticles) {
    const src = join(forge, "swarmforge", "constitution", "articles", name);
    if (!isFile(src)) continue;
    const articles = join(dest, "swarmforge", "constitution", "articles");
    mkdirSync(articles, { recursive: true });
    copyFileSync(src, join(articles, name));
  }
}

function copyPackConf(conf: string, dest: string, keepConf: boolean): void {
  if (keepConf || !isFile(conf)) return;
  mkdirSync(join(dest, "swarmforge"), { recursive: true });
  copyFileSync(conf, join(dest, "swarmforge", "swarmforge.conf"));
}

function copyPackArticles(articles: string, dest: string): void {
  if (!isDir(articles)) return;
  const target = join(dest, "swarmforge", "constitution", "articles");
  mkdirSync(target, { recursive: true });
  for (const name of readdirSync(articles)) {
    const file = join(articles, name);
    if (isFile(file) && !sharedArticles.includes(name)) copyFileSync(file, join(target, name));
  }
}

function copyPackLocal(packRoot: string, dest: string, keepConf: boolean): void {
  const roles = join(packRoot, "swarmforge", "roles");
  const constitution = join(packRoot, "swarmforge", "constitution.prompt");
  if (isDir(roles)) copyTreeReplace(roles, join(dest, "swarmforge", "roles"));
  copyPackConf(join(packRoot, "swarmforge", "swarmforge.conf"), dest, keepConf);
  if (isFile(constitution)) copyFileSync(constitution, join(dest, "swarmforge", "constitution.prompt"));
  copyPackArticles(join(packRoot, "swarmforge", "constitution", "articles"), dest);
}

function overlayPack(forge: string, dest: string, pack: string, keepConf: boolean): void {
  copySharedScripts(forge, dest);
  copySharedArticles(forge, dest);
  copyPackLocal(packDir(forge, pack), dest, keepConf);
}

function initGitIfNeeded(dir: string): void {
  if (existsSync(join(dir, ".git"))) return;
  run("git", ["init", dir]);
  run("git", ["-C", dir, "config", "user.email", "swarmforge@local"]);
  run("git", ["-C", dir, "config", "user.name", "SwarmForge"]);
  run("git", ["-C", dir, "branch", "-M", "master"]);
  const gitignore = join(dir, ".gitignore");
  if (!existsSync(gitignore)) writeFileSync(gitignore, ".swarmforge/\n.worktrees/\n");
  run("git", ["-C", dir, "add", "."]);
  run("git", ["-C", dir, "commit", "-q", "-m", "Initial swarmforge project"]);
}

function cloneGithub(url: string, dest: string): void {
  const result = run("git", ["clone", "--", url, dest]);
  if (result.exit !== 0) throw new HttpError(400, `Clone failed: ${`${result.err}\n${result.out}`.trim()}`);
}

export interface NewProject {
  name?: string;
  github?: unknown;
  pack?: string;
  conf?: string;
  mission?: string | null;
}

function validateNewProject(forge: string, spec: NewProject, dirName: string): string {
  if (isBlank(dirName)) throw new HttpError(400, "Missing project name");
  if (isBlank(spec.pack)) throw new HttpError(400, "Missing pack");
  if (!isDir(packDir(forge, spec.pack!))) throw new HttpError(400, `Unknown pack: ${spec.pack}`);
  if (existsSync(projectDir(forge, dirName))) throw new HttpError(409, `Project already exists: ${dirName}`);
  return spec.pack!;
}

function writeProjectFiles(dest: string, spec: NewProject): void {
  if (!isBlank(spec.conf)) {
    mkdirSync(join(dest, "swarmforge"), { recursive: true });
    writeFileSync(join(dest, "swarmforge", "swarmforge.conf"), spec.conf!);
  }
  const mission = spec.mission;
  if (mission !== undefined && mission !== null) {
    writeFileSync(join(dest, "mission.md"), mission.endsWith("\n") ? mission : `${mission}\n`);
  }
}

export function instantiate(forge: string, spec: NewProject): { name: string; path: string } {
  const github = !!spec.github;
  const dirName = inferredName(spec.name, github);
  const dest = projectDir(forge, dirName);
  const pack = validateNewProject(forge, spec, dirName);
  mkdirSync(projectsDir(forge), { recursive: true });
  if (github) cloneGithub(githubCloneUrl(spec.name ?? ""), dest);
  else mkdirSync(dest, { recursive: true });
  overlayPack(forge, dest, pack, false);
  writeProjectFiles(dest, spec);
  writePackName(dest, pack);
  if (!github) initGitIfNeeded(dest);
  return { name: dirName, path: dest };
}

function refresh(forge: string, name: string): { name: string; pack: string } {
  const dest = projectDir(forge, name);
  const pack = storedPack(dest);
  if (!isDir(dest)) throw new HttpError(404, `Unknown project: ${name}`);
  if (isBlank(pack)) throw new HttpError(400, `No pack recorded for ${name}`);
  overlayPack(forge, dest, pack!, true);
  return { name, pack: pack! };
}

const skipStart = (): boolean => process.env.SWARMFORGE_SKIP_START === "1";
const swarmforgeSh = (forge: string): string => join(forge, "swarmforge", "scripts", "swarmforge.sh");

function startProjectRuntime(forge: string, name: string): void {
  const dest = projectDir(forge, name);
  spawnBackground(swarmforgeSh(forge), ["--start-project", dest], join(dest, ".swarmforge", "start.log"));
}

function stopProjectRuntime(forge: string, name: string): void {
  run(swarmforgeSh(forge), ["--stop-project", projectDir(forge, name)]);
}

export function openProject(forge: string, name: string | undefined): { name: string; open: true } {
  const projectName = name ?? "";
  if (!isDir(projectDir(forge, projectName))) throw new HttpError(404, `Unknown project: ${projectName}`);
  if (projectOpen(forge, projectName)) throw new HttpError(409, `Project already open: ${projectName}`);
  refresh(forge, projectName);
  if (!skipStart()) startProjectRuntime(forge, projectName);
  markOpen(forge, projectName);
  return { name: projectName, open: true };
}

export function closeProject(forge: string, name: string | undefined): { name: string; open: false } {
  const projectName = name ?? "";
  if (!skipStart()) stopProjectRuntime(forge, projectName);
  markClosed(forge, projectName);
  return { name: projectName, open: false };
}

export function closeAllProjects(forge: string): void {
  for (const name of readOpenProjects(forge)) closeProject(forge, name);
}

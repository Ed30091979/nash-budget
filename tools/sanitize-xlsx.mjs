import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const FIXED_MTIME = new Date("1980-01-01T00:00:00.000Z");
const XML_SUFFIXES = new Set([".xml", ".rels"]);
const FORBIDDEN_MARKERS = [
  "x15ac:absPath",
  "/Users/",
  "/var/folders/",
  "<dc:creator",
  "<cp:lastModifiedBy",
  "<dcterms:created",
  "<dcterms:modified",
];

function scrubMetadata(xml) {
  let result = xml.replace(
    /<x15ac:absPath\b[^>]*(?:\/>|>[\s\S]*?<\/x15ac:absPath>)/gu,
    "",
  );

  for (const element of ["dc:creator", "cp:lastModifiedBy", "dcterms:created", "dcterms:modified"]) {
    result = result.replace(
      new RegExp(`<${element}\\b[^>]*(?:\\/>|>[\\s\\S]*?<\\/${element}>)`, "gu"),
      "",
    );
  }

  return result;
}

function assertSafeEntryName(entry) {
  const parts = entry.split("/");
  if (
    entry.length === 0
    || entry.startsWith("/")
    || entry.includes("\\")
    || entry.includes("\0")
    || entry.includes("\n")
    || parts.includes("..")
  ) {
    throw new Error(`Unsafe XLSX archive entry: ${JSON.stringify(entry)}`);
  }
}

async function listFiles(directory, relative = "") {
  const entries = await fs.readdir(path.join(directory, relative), { withFileTypes: true });
  const files = [];

  for (const entry of entries) {
    const relativePath = relative ? path.posix.join(relative, entry.name) : entry.name;
    const absolutePath = path.join(directory, relativePath);
    if (entry.isSymbolicLink()) {
      throw new Error(`Unexpected symlink in XLSX archive: ${relativePath}`);
    }
    if (entry.isDirectory()) {
      await fs.chmod(absolutePath, 0o755);
      files.push(...await listFiles(directory, relativePath));
    } else if (entry.isFile()) {
      files.push(relativePath);
    } else {
      throw new Error(`Unexpected XLSX entry type: ${relativePath}`);
    }
  }

  return files;
}

async function assertSanitized(directory, files) {
  for (const relativePath of files) {
    const contents = await fs.readFile(path.join(directory, relativePath));
    for (const marker of FORBIDDEN_MARKERS) {
      if (contents.includes(Buffer.from(marker))) {
        throw new Error(`Sanitizer left forbidden marker ${JSON.stringify(marker)} in ${relativePath}`);
      }
    }
  }
}

export async function sanitizeXlsx(inputPath) {
  const absoluteInputPath = path.resolve(inputPath);
  if (path.extname(absoluteInputPath).toLowerCase() !== ".xlsx") {
    throw new Error("sanitize-xlsx expects an .xlsx file");
  }

  const archiveList = await execFileAsync("unzip", ["-Z1", absoluteInputPath], {
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
  });
  const archiveEntries = archiveList.stdout.split(/\r?\n/u).filter(Boolean);
  if (archiveEntries.length === 0) {
    throw new Error("XLSX archive is empty");
  }
  archiveEntries.forEach(assertSafeEntryName);

  const temporaryDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "family-budget-xlsx-"));
  const temporaryArchive = path.join(
    path.dirname(absoluteInputPath),
    `.${path.basename(absoluteInputPath)}.${process.pid}.sanitizing`,
  );

  try {
    await execFileAsync("unzip", ["-qq", absoluteInputPath, "-d", temporaryDirectory]);
    const files = (await listFiles(temporaryDirectory)).sort();

    for (const relativePath of files) {
      const absolutePath = path.join(temporaryDirectory, relativePath);
      if (XML_SUFFIXES.has(path.extname(relativePath).toLowerCase())) {
        const xml = await fs.readFile(absolutePath, "utf8");
        const sanitized = scrubMetadata(xml);
        if (sanitized !== xml) {
          await fs.writeFile(absolutePath, sanitized, "utf8");
        }
      }
      await fs.chmod(absolutePath, 0o644);
      await fs.utimes(absolutePath, FIXED_MTIME, FIXED_MTIME);
    }

    await assertSanitized(temporaryDirectory, files);
    await fs.rm(temporaryArchive, { force: true });
    await execFileAsync("zip", ["-X", "-q", "-D", temporaryArchive, ...files], {
      cwd: temporaryDirectory,
      env: { ...process.env, TZ: "UTC" },
      maxBuffer: 16 * 1024 * 1024,
    });
    await fs.chmod(temporaryArchive, 0o644);
    await execFileAsync("unzip", ["-tqq", temporaryArchive], { maxBuffer: 16 * 1024 * 1024 });
    await fs.rename(temporaryArchive, absoluteInputPath);

    return { inputPath: absoluteInputPath, entries: files.length };
  } finally {
    await fs.rm(temporaryDirectory, { recursive: true, force: true });
    await fs.rm(temporaryArchive, { force: true });
  }
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : null;
if (invokedPath === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  if (args.length !== 1) {
    throw new Error("Usage: node tools/sanitize-xlsx.mjs <workbook.xlsx>");
  }
  console.log(JSON.stringify(await sanitizeXlsx(args[0])));
}

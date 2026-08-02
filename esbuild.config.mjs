import esbuild from "esbuild";
import process from "process";
import fs from "fs";
import path from "path";
import { builtinModules, createRequire } from "module";
import { fileURLToPath } from "url";

const require = createRequire(import.meta.url);
const prod = process.argv[2] === "production";

// --- Build output ------------------------------------------------------------
// Building and installing are separate steps. The build ALWAYS produces the three
// release files in a repo-local dist/, so a fresh clone (or CI) can build with no
// vault present and no machine-specific configuration.
const ROOT = path.dirname(fileURLToPath(import.meta.url));
const DIST_DIR = path.join(ROOT, "dist");
const OUTFILE = path.join(DIST_DIR, "main.js");
const RELEASE_FILES = ["manifest.json", "styles.css"];
fs.mkdirSync(DIST_DIR, { recursive: true });

// --- Optional install target --------------------------------------------------
// After each successful build the release files are mirrored into an Obsidian
// plugin folder, if one is configured. Resolution order:
//   1. LOCAL_PDF_ANNOTATOR_PLUGIN_DIR   (CI / one-off overrides)
//   2. .plugin-dir                      (gitignored, one line — the usual case)
//   3. nothing                          (build dist/ only, and say so)
// A path is NEVER invented: the parent must already exist, so a stale or foreign
// path fails with an actionable message instead of silently creating a junk tree
// or dying with EACCES somewhere under another user's home directory.
function resolvePluginDir() {
  const fromEnv = process.env.LOCAL_PDF_ANNOTATOR_PLUGIN_DIR?.trim();
  if (fromEnv) return { dir: path.resolve(fromEnv), source: "LOCAL_PDF_ANNOTATOR_PLUGIN_DIR" };

  const configPath = path.join(ROOT, ".plugin-dir");
  if (fs.existsSync(configPath)) {
    const line = fs
      .readFileSync(configPath, "utf8")
      .split("\n")
      .map((l) => l.trim())
      .find((l) => l && !l.startsWith("#"));
    if (line) return { dir: path.resolve(ROOT, line), source: ".plugin-dir" };
  }

  return null;
}

const INSTALL = resolvePluginDir();
if (INSTALL) {
  const parent = path.dirname(INSTALL.dir);
  if (!fs.existsSync(parent)) {
    throw new Error(
      `[build] plugin install path from ${INSTALL.source} does not exist:\n` +
        `          ${INSTALL.dir}\n` +
        `        Its parent folder (${parent}) is missing, so this is almost certainly a\n` +
        `        stale path from another machine. Point .plugin-dir or\n` +
        `        LOCAL_PDF_ANNOTATOR_PLUGIN_DIR at <vault>/.obsidian/plugins/local-pdf-annotator,\n` +
        `        or remove it to build into dist/ only.`
    );
  }
  // Only the leaf plugin folder is ours to create — never the vault around it.
  fs.mkdirSync(INSTALL.dir, { recursive: true });
  console.log(`[build] installing to ${INSTALL.dir} (via ${INSTALL.source})`);
} else {
  console.log("[build] no plugin dir configured — building to dist/ only.");
  console.log("[build] to install on each build, write the path into .plugin-dir");
}

// --- Resolve the SINGLE installed pdfjs-dist build ---------------------------
// API and worker are pulled from the SAME installed package => identical version
// by construction. We capture the version at build time and inject it so the
// runtime can assert against pdfjsLib.version.
const PDFJS_PKG = require("pdfjs-dist/package.json");
const PDFJS_VERSION = PDFJS_PKG.version;
const WORKER_FILE = require.resolve("pdfjs-dist/legacy/build/pdf.worker.min.js");
console.log(`[build] pdfjs-dist@${PDFJS_VERSION}`);
console.log(`[build] inlining worker: ${WORKER_FILE}`);

function replaceRequired(contents, needle, replacement, label, sourcePath) {
  if (!contents.includes(needle)) {
    throw new Error(`[build] could not patch ${label} in ${sourcePath}`);
  }
  return contents.replace(needle, replacement);
}

function sanitizePdfJsApi(contents, sourcePath) {
  if (contents.includes(`function isEvalSupported() {
  try {
    new Function("");
    return true;
  } catch {
    return false;
  }
}`)) {
    contents = replaceRequired(
      contents,
      `function isEvalSupported() {
  try {
    new Function("");
    return true;
  } catch {
    return false;
  }
}`,
      `function isEvalSupported() {
  return false;
}`,
      "eval feature test",
      sourcePath
    );
  } else {
    contents = replaceRequired(
      contents,
      `function isEvalSupported(){try{new Function("");return!0}catch{return!1}}`,
      `function isEvalSupported(){return!1}`,
      "minified eval feature test",
      sourcePath
    );
  }

  contents = contents.replaceAll(`Function("return this")()`, "globalThis");
  contents = contents.replaceAll(`Function('return this')()`, "globalThis");

  contents = contents.replace(
    /function loadScript\(src(?:, removeScriptElement = false)?\) \{[\s\S]*?\n\}/,
    `function loadScript(src, removeScriptElement = false) {
  return Promise.reject(new Error("Local PDF Annotator disables pdf.js dynamic script fallback."));
}`
  );
  contents = contents.replace(
    /function loadScript\(src\) \{\n  let removeScriptElement = arguments\.length > 1 && arguments\[1\] !== undefined \? arguments\[1\] : false;[\s\S]*?\n\}/,
    `function loadScript(src) {
  return Promise.reject(new Error("Local PDF Annotator disables pdf.js dynamic script fallback."));
}`
  );
  contents = contents.replace(
    /e\.loadScript=function loadScript\(t\)\{[\s\S]*?\(document\.head\|\|document\.documentElement\)\.append\(r\)\}\)\)\};/,
    `e.loadScript=function loadScript(t){return Promise.reject(new Error("Local PDF Annotator disables pdf.js dynamic script fallback."))};`
  );
  if (contents.includes(`document.createElement("script")`)) {
    throw new Error(`[build] could not remove pdf.js dynamic script fallback in ${sourcePath}`);
  }

  if (contents.includes(`const worker = eval("require")(this.workerSrc);`)) {
    contents = replaceRequired(
      contents,
      `const worker = eval("require")(this.workerSrc);`,
      `throw new Error("Local PDF Annotator disables pdf.js Node fake-worker fallback.");`,
      "Node fake-worker eval fallback",
      sourcePath
    );
  } else {
    contents = replaceRequired(
      contents,
      `const worker=eval("require")(this.workerSrc);`,
      `throw new Error("Local PDF Annotator disables pdf.js Node fake-worker fallback.")`,
      "minified Node fake-worker eval fallback",
      sourcePath
    );
  }

  if (contents.includes(`return this.compiledGlyphs[character] = new Function("c", "size", jsBuf.join(""));`)) {
    contents = replaceRequired(
      contents,
      `return this.compiledGlyphs[character] = new Function("c", "size", jsBuf.join(""));`,
      `return this.compiledGlyphs[character] = function (c, size) {
        for (const current of cmds) {
          if (current.cmd === "scale") {
            current.args = [size, -size];
          }
          c[current.cmd].apply(c, current.args);
        }
      };`,
      "glyph eval fast path",
      sourcePath
    );
  } else {
    contents = replaceRequired(
      contents,
      `return this.compiledGlyphs[e]=new Function("c","size",t.join(""))`,
      `return this.compiledGlyphs[e]=function(t,e){for(const i of n){"scale"===i.cmd&&(i.args=[e,-e]);t[i.cmd].apply(t,i.args)}}`,
      "minified glyph eval fast path",
      sourcePath
    );
  }

  for (const forbidden of ["new Function", `Function("`, `Function('`, "eval(", `createElement("script")`]) {
    if (contents.includes(forbidden)) {
      throw new Error(`[build] forbidden pdf.js token still present after patch: ${forbidden}`);
    }
  }

  contents = stripPdfJsNodeOnlyAccess(contents, sourcePath);

  return contents;
}

function replaceOptional(contents, pattern, replacement) {
  return contents.replace(pattern, replacement);
}

function stripPdfJsNodeOnlyAccess(contents, sourcePath) {
  const disabled =
    `new Error("Local PDF Annotator disables pdf.js Node-only filesystem/network fallback.")`;

  contents = replaceOptional(
    contents,
    /;\n\{\n  \(function checkDOMMatrix\(\) \{[\s\S]*?\n  \}\)\(\);\n\}\nconst fetchData/,
    `;\n{\n}\nconst fetchData`
  );

  contents = replaceOptional(
    contents,
    /const fetchData = function \(url\) \{[\s\S]*?\n\};(?=\nclass NodeFilterFactory)/,
    `const fetchData = function (url) {
  return Promise.reject(${disabled});
};`
  );

  contents = replaceOptional(
    contents,
    /class NodeCanvasFactory extends _base_factory\.BaseCanvasFactory \{[\s\S]*?\n\}\nexports\.NodeCanvasFactory = NodeCanvasFactory;/,
    `class NodeCanvasFactory extends _base_factory.BaseCanvasFactory {
  _createCanvas(width, height) {
    throw ${disabled};
  }
}
exports.NodeCanvasFactory = NodeCanvasFactory;`
  );

  contents = replaceOptional(
    contents,
    /function parseUrl\(sourceUrl\) \{[\s\S]*?\n\}(?=\nclass PDFNodeStream)/,
    `function parseUrl(sourceUrl) {
  throw ${disabled};
}`
  );

  contents = replaceOptional(
    contents,
    /class PDFNodeStreamFullReader extends BaseFullReader \{[\s\S]*?\n\}(?=\nclass PDFNodeStreamRangeReader)/,
    `class PDFNodeStreamFullReader extends BaseFullReader {
  constructor() {
    throw ${disabled};
  }
}`
  );

  contents = replaceOptional(
    contents,
    /class PDFNodeStreamRangeReader extends BaseRangeReader \{[\s\S]*?\n\}(?=\nclass PDFNodeStreamFsFullReader)/,
    `class PDFNodeStreamRangeReader extends BaseRangeReader {
  constructor() {
    throw ${disabled};
  }
}`
  );

  contents = replaceOptional(
    contents,
    /class PDFNodeStreamFsFullReader extends BaseFullReader \{[\s\S]*?\n\}(?=\nclass PDFNodeStreamFsRangeReader)/,
    `class PDFNodeStreamFsFullReader extends BaseFullReader {
  constructor() {
    throw ${disabled};
  }
}`
  );

  contents = replaceOptional(
    contents,
    /class PDFNodeStreamFsRangeReader extends BaseRangeReader \{[\s\S]*?\n\}(?=\n\n\/\*\*\*\/ \}\),|\n\n\/\*\*\*\/\}\),|\n\n\/\*\*\*\/\}\)\;)/,
    `class PDFNodeStreamFsRangeReader extends BaseRangeReader {
  constructor() {
    throw ${disabled};
  }
}`
  );

  for (const forbidden of [`require("fs")`, `require("http")`, `require("https")`, `require("url")`, `require("canvas")`]) {
    if (contents.includes(forbidden)) {
      throw new Error(`[build] forbidden pdf.js Node fallback token still present after patch: ${forbidden} in ${sourcePath}`);
    }
  }

  return contents;
}

function sanitizePdfJsWorker(contents, sourcePath) {
  const replacements = [
    [
      `function isEvalSupported(){try{new Function("");return!0}catch{return!1}}`,
      `function isEvalSupported(){return!1}`,
      "worker eval feature test",
    ],
    [
      `if(a&&n.FeatureTest.isEvalSupported){const e=(new PostScriptCompiler).compile(h,o,c);if(e)return new Function("src","srcOffset","dest","destOffset",e)}`,
      `if(false){}`,
      "worker PostScript eval fast path",
    ],
    [
      `Function("return this")()`,
      `globalThis`,
      "worker core-js global fallback",
    ],
  ];

  for (const [needle, replacement, label] of replacements) {
    contents = replaceRequired(contents, needle, replacement, label, sourcePath);
  }

  for (const forbidden of ["new Function", `Function("`, "eval(", `createElement("script")`]) {
    if (contents.includes(forbidden)) {
      throw new Error(`[build] forbidden pdf.js worker token still present after patch: ${forbidden}`);
    }
  }

  return contents;
}

function sanitizePdfJsSandbox(contents, sourcePath) {
  if (contents.includes(`Function("return this")()`)) {
    contents = contents.replaceAll(`Function("return this")()`, "globalThis");
  }
  if (contents.includes(`Function('return this')()`)) {
    contents = contents.replaceAll(`Function('return this')()`, "globalThis");
  }
  if (contents.includes(`Function(\\"return this\\")()`)) {
    contents = contents.replaceAll(`Function(\\"return this\\")()`, "globalThis");
  }

  for (const forbidden of ["new Function", `Function("`, `Function('`, `Function(\\"`, "eval(", `createElement("script")`]) {
    if (contents.includes(forbidden)) {
      throw new Error(`[build] forbidden pdf.js sandbox token still present after patch: ${forbidden}`);
    }
  }

  return contents;
}

function sanitizePdfJsImageDecoder(contents, sourcePath) {
  contents = contents.replaceAll(`Function("return this")()`, "globalThis");
  contents = contents.replaceAll(`Function('return this')()`, "globalThis");
  if (contents.includes(`function isEvalSupported(){try{new Function("");return!0}catch{return!1}}`)) {
    contents = contents.replaceAll(
      `function isEvalSupported(){try{new Function("");return!0}catch{return!1}}`,
      `function isEvalSupported(){return!1}`
    );
  }

  for (const forbidden of ["new Function", `Function("`, `Function('`, "eval(", `createElement("script")`]) {
    if (contents.includes(forbidden)) {
      throw new Error(`[build] forbidden pdf.js image-decoder token still present after patch: ${forbidden}`);
    }
  }

  return contents;
}

function sanitizePdfJsLoadedFile(args) {
  const sourcePath = args.path;
  const contents = fs.readFileSync(sourcePath, "utf8");

  if (/pdfjs-dist[/\\](legacy[/\\])?build[/\\]pdf(\.min)?\.js$/.test(sourcePath)) {
    console.log(`[build] sanitizing pdf.js API: ${path.relative(process.cwd(), sourcePath)}`);
    return sanitizePdfJsApi(contents, sourcePath);
  }
  if (/pdfjs-dist[/\\](legacy[/\\])?build[/\\]pdf\.sandbox(\.min)?\.js$/.test(sourcePath)) {
    console.log(`[build] sanitizing pdf.js sandbox: ${path.relative(process.cwd(), sourcePath)}`);
    return sanitizePdfJsSandbox(contents, sourcePath);
  }
  if (/pdfjs-dist[/\\](legacy[/\\])?image_decoders[/\\]pdf\.image_decoders(\.min)?\.js$/.test(sourcePath)) {
    console.log(`[build] sanitizing pdf.js image decoder: ${path.relative(process.cwd(), sourcePath)}`);
    return sanitizePdfJsImageDecoder(contents, sourcePath);
  }

  return null;
}

// esbuild plugin: inline the pdf.js worker as a STRING (text loader). At runtime
// we turn this string into a Blob URL classic worker. Never a path on disk.
const inlinePdfWorker = {
  name: "inline-pdf-worker",
  setup(build) {
    build.onResolve({ filter: /^pdfjs-worker-inline$/ }, () => ({
      path: WORKER_FILE,
      namespace: "pdf-worker-text",
    }));
    build.onLoad({ filter: /.*/, namespace: "pdf-worker-text" }, (args) => ({
      contents: sanitizePdfJsWorker(fs.readFileSync(args.path, "utf8"), args.path),
      loader: "text",
    }));
  },
};

// pdf.js includes a fake-worker fallback that dynamically injects a <script>.
// This plugin never uses that path: every document gets an explicit Blob Worker
// port from createDedicatedWorker(). Removing the fallback keeps the release
// bundle compatible with Obsidian's community-plugin scanner.
const stripPdfJsDynamicScriptFallback = {
  name: "strip-pdfjs-dynamic-script-fallback",
  setup(build) {
    build.onLoad({ filter: /pdfjs-dist[/\\].*\.js$/ }, (args) => {
      const contents = sanitizePdfJsLoadedFile(args);
      return contents == null ? undefined : { contents, loader: "js" };
    });
  },
};

// esbuild plugin: complete dist/ with manifest + styles, then mirror the release
// files into the configured plugin folder (if any). dist/ is always the source of
// truth; installing is a copy on top of a build that already succeeded.
const emitRelease = {
  name: "emit-release",
  setup(build) {
    build.onEnd((result) => {
      if (result.errors.length) return;
      for (const f of RELEASE_FILES) {
        try {
          fs.copyFileSync(path.join(ROOT, f), path.join(DIST_DIR, f));
        } catch (e) {
          console.warn(`[build] could not stage ${f}: ${e.message}`);
        }
      }

      const stamp = new Date().toLocaleTimeString();
      if (!INSTALL) {
        console.log(`[build] -> ${DIST_DIR} (main.js, ${RELEASE_FILES.join(", ")})  @ ${stamp}`);
        return;
      }

      for (const f of ["main.js", ...RELEASE_FILES]) {
        try {
          fs.copyFileSync(path.join(DIST_DIR, f), path.join(INSTALL.dir, f));
        } catch (e) {
          console.warn(`[build] could not install ${f}: ${e.message}`);
        }
      }
      console.log(`[build] -> ${DIST_DIR} + installed to ${INSTALL.dir}  @ ${stamp}`);
    });
  },
};

const buildOptions = {
  entryPoints: ["src/main.ts"],
  bundle: true,
  platform: "browser",
  format: "cjs",
  target: "es2020",
  logLevel: "info",
  sourcemap: prod ? false : "inline",
  treeShaking: true,
  minify: prod,
  outfile: OUTFILE,
  // Provided by Obsidian/Electron at runtime, or never used in the browser path.
  external: [
    "obsidian",
    "electron",
    "@codemirror/autocomplete",
    "@codemirror/collab",
    "@codemirror/commands",
    "@codemirror/language",
    "@codemirror/lint",
    "@codemirror/search",
    "@codemirror/state",
    "@codemirror/view",
    "@lezer/common",
    "@lezer/highlight",
    "@lezer/lr",
    "canvas", // pdfjs Node-only optional dep; dead in the browser path
    ...builtinModules,
  ],
  define: {
    // Build-time pin used by the runtime self-check.
    __PDFJS_BUILD_VERSION__: JSON.stringify(PDFJS_VERSION),
    "process.env.NODE_ENV": JSON.stringify(prod ? "production" : "development"),
  },
  plugins: [stripPdfJsDynamicScriptFallback, inlinePdfWorker, emitRelease],
};

if (prod) {
  await esbuild.build(buildOptions);
} else {
  const ctx = await esbuild.context(buildOptions);
  await ctx.watch();
  console.log("[watch] esbuild watching src/ … (Ctrl-C to stop)");
}

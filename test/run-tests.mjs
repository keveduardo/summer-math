// Regression tests for the Beach Math logic in public/index.html.
// The app has no build step (JSX is transpiled in the browser), so we transpile the
// inline <script type="text/babel"> with esbuild, run it in a vm with a React stub, and
// assert on the pure functions. Run: `npm test`.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import vm from "node:vm";
import { transformSync } from "esbuild";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const html = readFileSync(join(root, "public", "index.html"), "utf8");
const m = html.match(/<script type="text\/babel"[^>]*>([\s\S]*?)<\/script>/);
if (!m) { console.error("Could not find the babel script in public/index.html"); process.exit(2); }

let src = m[1].replace(/const root = ReactDOM[\s\S]*$/, "");
src += `\nglobalThis.__exp = { parseNum, parseInequality, isCorrect, normalizeProgress, applyAnswer,
  nextKitPiece, streakMilestones, DAILY_GOAL, MAX_DAILY_PRIZES, dayStr, yesterdayStr,
  TEAMS, TEAM_MAP, genOneStepIneq };`;
const js = transformSync(src, { loader: "jsx" }).code;

const hook = () => {};
const React = { createElement: () => ({}), Fragment: "Fragment", useState: hook, useEffect: hook, useRef: () => ({}), useMemo: (f) => (typeof f === "function" ? f() : f) };
const sandbox = {
  React, ReactDOM: { createRoot: () => ({ render: () => {} }) },
  console, Date, Math, Object, Array, JSON, String, Number, Set, Map, RegExp,
  TextEncoder, TextDecoder, crypto: (await import("node:crypto")).webcrypto,
  btoa: (s) => Buffer.from(s, "binary").toString("base64"),
  atob: (s) => Buffer.from(s, "base64").toString("binary"),
  setTimeout, clearTimeout, document: { getElementById: () => ({}) },
  localStorage: { getItem: () => null, setItem: () => {} }, fetch: () => Promise.reject(new Error("no net")),
};
sandbox.globalThis = sandbox;
vm.createContext(sandbox);
vm.runInContext(js, sandbox);
const X = sandbox.__exp;

let pass = 0, fail = 0;
const near = (a, b) => a !== null && Math.abs(a - b) < 1e-9;
const ok = (n, c) => { c ? pass++ : (fail++, 0); console.log((c ? "ok   " : "FAIL ") + n); };
const eq = (n, a, b) => ok(n, JSON.stringify(a) === JSON.stringify(b));

// ---- answer parsing ----
ok("parseNum 1 1/15 = 16/15 (mixed number)", near(X.parseNum("1 1/15"), 16 / 15));
ok("parseNum -1 1/15 = -16/15", near(X.parseNum("-1 1/15"), -16 / 15));
ok("parseNum 11/15 (plain fraction) unaffected", near(X.parseNum("11/15"), 11 / 15));
ok("parseNum x = 5 (equation form)", near(X.parseNum("x = 5"), 5));
ok("parseNum unicode minus -7", near(X.parseNum("−7"), -7));
ok("parseNum $3 / 50%", near(X.parseNum("$3"), 3) && near(X.parseNum("50%"), 50));
ok("parseNum 1/0 = null", X.parseNum("1/0") === null);
ok("parseNum '' = null", X.parseNum("") === null);

// ---- inequalities (grade direction + value, incl. >= mapping) ----
const ineq = { type: "inequality", op: ">", value: 5, tol: 0.011 };
ok("isCorrect x > 5 accepted", X.isCorrect(ineq, "x > 5") === true);
ok("isCorrect >=5 maps and is rejected for >", X.isCorrect({ ...ineq, op: "≥" }, ">= 5") === true);
ok("isCorrect wrong direction rejected", X.isCorrect(ineq, "< 5") === false);
ok("isCorrect wrong value rejected", X.isCorrect(ineq, "> 6") === false);

// independently re-solve generated inequalities to confirm the generator's math
const flip = { "<": ">", ">": "<", "≤": "≥", "≥": "≤" };
function trueSolve(prompt) {
  const s = prompt.replace("Solve for x:", "").replace(/−/g, "-").trim();
  const mm = s.match(/^(.+?)\s*([<>≤≥])\s*(-?\d+)$/); if (!mm) return null;
  const lhs = mm[1].replace(/\s+/g, ""), op = mm[2], rhs = Number(mm[3]); let c, k, g;
  if (g = lhs.match(/^x\+(\d+)$/)) { k = 1; c = Number(g[1]); }
  else if (g = lhs.match(/^x-(\d+)$/)) { k = 1; c = -Number(g[1]); }
  else if (g = lhs.match(/^(-?\d+)x$/)) { k = Number(g[1]); c = 0; }
  else return null;
  return { op: k < 0 ? flip[op] : op, val: (rhs - c) / k };
}
let mathErr = 0, dispErr = 0, dirErr = 0;
for (let i = 0; i < 5000; i++) {
  const p = X.genOneStepIneq();
  const sol = trueSolve(p.prompt);
  if (!sol || sol.op !== p.op || !near(sol.val, p.value)) mathErr++;
  if (!X.isCorrect(p, p.display)) dispErr++;
  if (X.isCorrect(p, flip[p.op] + " " + p.value)) dirErr++;
}
ok("inequality generator math correct (5000)", mathErr === 0);
ok("inequality displayed solution always accepted", dispErr === 0);
ok("inequality flipped direction always rejected", dirErr === 0);

// ---- progress normalization ----
const n0 = X.normalizeProgress(null);
ok("normalize(null) fills avatar/kit", n0.avatar.skin === 0 && Array.isArray(n0.kit.closet) && n0.kit.variant === "home");
eq("normalize keeps xp", X.normalizeProgress({ xp: 42 }).xp, 42);
ok("normalize old save (no kit) safe", X.normalizeProgress({ xp: 1, topics: {} }).kit.tokens === 0);

// ---- reward engine: up to MAX_DAILY_PRIZES base pieces per day ----
const prob = { topicId: "fractions", key: "f|x", prompt: "x", display: "1", explain: "", value: 1, tol: 0.01, type: "numeric" };
const today = X.dayStr();
let p = X.normalizeProgress({ today: { day: today, count: 0 }, lastDay: today, streak: 1 });
for (let i = 0; i < 12; i++) p = X.applyAnswer(p, true, prob);
eq("12 answers -> 1 piece", p.kit.pieces, ["boots"]);
for (let i = 0; i < 12; i++) p = X.applyAnswer(p, true, prob);
eq("24 answers -> 2 pieces", p.kit.pieces, ["boots", "socks"]);
const xp24 = p.xp;
for (let i = 0; i < 12; i++) p = X.applyAnswer(p, true, prob);
eq("36 answers -> still 2 (daily cap)", p.kit.pieces, ["boots", "socks"]);
ok("bonus XP past cap", p.xp > xp24);
eq("streakMilestones(30)", X.streakMilestones(30), [3, 7, 14, 30]);

// ---- team kit data integrity (48 teams, home+away, valid hex) ----
ok("48 teams", X.TEAMS.length === 48 && Object.keys(X.TEAM_MAP).length === 48);
const fields = ["pattern", "primary", "secondary", "shorts", "socks", "trim"];
let dataErr = [];
for (const t of X.TEAMS) for (const v of ["home", "away"]) {
  if (!t[v]) { dataErr.push(`${t.id} no ${v}`); continue; }
  for (const f of fields) if (t[v][f] == null) dataErr.push(`${t.id}.${v} no ${f}`);
  for (const f of ["primary", "secondary", "shorts", "socks", "trim"])
    if (!/^#[0-9A-Fa-f]{6}$/.test(t[v][f])) dataErr.push(`${t.id}.${v}.${f}=${t[v][f]}`);
}
ok("all 96 kits complete + valid hex", dataErr.length === 0);
if (dataErr.length) console.log("  " + dataErr.slice(0, 6).join("; "));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

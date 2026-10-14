// "Nibblets of Kernow", the singalong: the song, its words lit as they're sung, and a stage that
// acts them out. The stage is one canvas, drawn from the song's clock every frame, so seeking and
// pausing just work; the words are text over it. The landing page imports this module when
// someone asks to sing, and calls open().
//
// song.json holds the lyrics, each word with the second it starts and ends (force-aligned to the
// song's separated vocals), the beats, and the song's loudness 30 times a second (bass, overall,
// treble and the voice alone, one byte each, base64). scripts/singalong.py makes it.
import song from "./song.json";
import "./player.css";

type Kind =
  "intro" | "verse1" | "chorus" | "verse2" | "verse3" | "verse4" | "verse5" | "final" | "outro";

const data = song as unknown as {
  lines: [Kind, [string, number, number][]][];
  beats: number[];
  env: string;
};

const SONG_URL = "/nibblets-of-kernow.mp3";
const SONG_LENGTH = 189.52;
const INSTALL = "curl -fsSL https://nibblets.dev/install.sh | bash";
const FONT = "Fredoka, ui-rounded, system-ui, sans-serif";
const MONO = 'ui-monospace, "SF Mono", Menlo, Consolas, monospace';
const calm = matchMedia("(prefers-reduced-motion: reduce)").matches;

// ---------------------------------------------------------------- small maths

const TAU = Math.PI * 2;
const clamp = (v: number, a: number, b: number) => (v < a ? a : v > b ? b : v);
const lerp = (a: number, b: number, k: number) => a + (b - a) * k;
const out3 = (k: number) => 1 - Math.pow(1 - clamp(k, 0, 1), 3);
// (a small overshoot: things arrive, and settle)
const back = (k: number) => {
  k = clamp(k, 0, 1) - 1;
  return 1 + k * k * (2.4 * k + 1.4);
};
function hash(n: number) {
  n = Math.sin(n * 127.1 + 311.7) * 43758.5453;
  return n - Math.floor(n);
}
const keyOf = (text: string) => text.toLowerCase().replace(/[^a-z0-9]/g, "");

const envBytes = Uint8Array.from(atob(data.env), (c) => c.charCodeAt(0));
/** How loud the song is at t: 0 bass, 1 overall, 2 treble, 3 the voice. */
function env(t: number, k: 0 | 1 | 2 | 3) {
  const f = t * 30;
  const i = Math.floor(f);
  if (i < 0 || i >= envBytes.length / 4 - 1) return 0;
  const a = envBytes[i * 4 + k];
  const b = envBytes[i * 4 + 4 + k];
  return (a + (b - a) * (f - i)) / 255;
}

const beats = data.beats;
/** The beat t is in, how far through it, and a kick that's 1 on the beat and falls away. */
function beatAt(t: number) {
  let lo = 0;
  let hi = beats.length - 1;
  if (t < beats[0]) return { i: -1, phase: 0, kick: 0 };
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (beats[mid] <= t) lo = mid;
    else hi = mid - 1;
  }
  const len = lo + 1 < beats.length ? beats[lo + 1] - beats[lo] : 0.45;
  const phase = clamp((t - beats[lo]) / len, 0, 1);
  return { i: lo, phase, kick: Math.pow(1 - phase, 3) };
}

/**
 * A slow swell, 0 to 1 and back over two beats (about once a second), for anything that glows in
 * time. Lights only ever swell like this, never flash on the beat: flashing more than three times
 * a second can bring on seizures. (And with reduced motion, they hold still.)
 */
function swell(t: number) {
  const b = beatAt(t);
  if (calm || b.i < 0) return 0.5;
  return Math.sin((((b.i % 2) + b.phase) / 2) * Math.PI);
}
/** How many swells have passed: which jar's turn it is to glow. */
const swellIndex = (t: number) => Math.max(0, beatAt(t).i >> 1);

// ---------------------------------------------------------------- the song as data

interface Word {
  text: string;
  key: string;
  s: number;
  e: number;
  el?: HTMLSpanElement;
  p: number;
  on: boolean;
}
interface Line {
  i: number;
  sec: Kind;
  words: Word[];
  s: number;
  e: number;
  show: number;
  hide: number;
  el?: HTMLDivElement;
}

const lines: Line[] = data.lines.map(([sec, ws], i) => {
  const words = ws.map(([text, s, e]) => ({ text, key: keyOf(text), s, e, p: -1, on: false }));
  return { i, sec, words, s: words[0].s, e: words[words.length - 1].e, show: 0, hide: 0 };
});
// A line takes the stage a little before its first word (once the line before has mostly sung its
// last), and leaves when the next one comes, or just after its last word.
lines.forEach((l, i) => {
  const before = lines[i - 1];
  if (!before) {
    l.show = l.s - 3;
    return;
  }
  const last = before.words[before.words.length - 1];
  l.show = Math.max(last.s + 0.6 * (last.e - last.s), l.s - 0.6);
  if (l.show > l.s - 0.05) l.show = Math.max(last.s + 0.1, l.s - 0.05);
});
lines.forEach((l, i) => {
  l.hide = i + 1 < lines.length ? Math.min(lines[i + 1].show, l.e + 0.5) : l.e + 2.5;
});
const words = lines.flatMap((l) => l.words);
const firstWord = (key: string) => words.find((w) => w.key === key);
const startsOf = (keys: string[]) => words.filter((w) => keys.includes(w.key)).map((w) => w.s);

/** 1 just as one of these words is sung, falling to 0 over `dur` seconds. */
function recent(starts: number[], t: number, dur: number) {
  let v = 0;
  for (const s of starts) if (t >= s && t < s + dur) v = Math.max(v, 1 - (t - s) / dur);
  return v;
}

interface Section {
  kind: Kind;
  at: number;
  s: number;
}
const sections: Section[] = [{ kind: "intro", at: 0, s: 0 }];
for (const l of lines) {
  const last = sections[sections.length - 1];
  if (last.kind === l.sec) continue;
  // (a section's look arrives a little before its first word)
  const before = lines[l.i - 1];
  const at = before
    ? Math.min(l.s - 0.05, Math.max(before.words[before.words.length - 1].s + 0.3, l.s - 1.4))
    : l.s - 1.4;
  sections.push({ kind: l.sec, at, s: l.s });
}
const ending = lines[lines.length - 1].e + 0.6;
sections.push({ kind: "outro", at: ending, s: ending });
function sectionAt(t: number) {
  let i = 0;
  while (i + 1 < sections.length && sections[i + 1].at <= t) i++;
  return i;
}

const NAMES: Record<Kind, string> = {
  intro: "Tuning the fiddles",
  verse1: "Verse one · down the mine",
  chorus: "Chorus! Everybody!",
  verse2: "Verse two · Cousin Jack",
  verse3: "Verse three · the litter",
  verse4: "Verse four · the cunning fox",
  verse5: "Verse five · down the pub",
  final: "Last chorus, louder!",
  outro: "All together now",
};
const TAGS: Record<Kind, string> = {
  intro: "#ffd27a",
  verse1: "#5db6ff",
  chorus: "#ffb36b",
  verse2: "#8ee6d4",
  verse3: "#f38020",
  verse4: "#ff9a5c",
  verse5: "#ffd27a",
  final: "#ffffff",
  outro: "#ffd27a",
};

// A word or two of explanation, the first time something comes up.
const HINT_TEXT: [string, string][] = [
  ["docker", "Every nibblet lives in a <b>container</b> of its own"],
  ["heartbeat", "A nibblet wakes on a <b>heartbeat</b>, and on schedules it sets itself"],
  ["postgres", "Memories live in <b>Postgres</b>, with pgvector to find them again"],
  ["litter", "Big jobs get split up: a nibblet hatches <b>sub-agents</b> of its own"],
  ["chromium", "Watch a nibblet's browser live, and <b>take over</b> if you like"],
  ["credproxys", "Your tokens stay with the <b>credproxy</b>; containers never see them"],
  ["guard", "The guard <b>asks first</b> before a nibblet runs a risky tool"],
  ["curl", "One line on a Linux box: <b>curl, pipe, done</b>"],
];
const hints = HINT_TEXT.flatMap(([key, html]) => {
  const w = firstWord(key);
  return w ? [{ at: w.s - 0.2, html }] : [];
}).sort((a, b) => a.at - b.at);

// Things that pop up on the stage when a word is sung.
type PropKind =
  | "heart"
  | "crumbs"
  | "flag"
  | "pasty"
  | "elephant"
  | "candle"
  | "tin"
  | "cloud"
  | "browser"
  | "wheel"
  | "coins"
  | "stamp"
  | "mugs"
  | "sparkles"
  | "badge"
  | "dialog";
const PROP_WORDS: Record<string, [PropKind, string?]> = {
  heartbeat: ["heart"],
  sleeps: ["stamp", "NO NAPS"],
  nibble: ["crumbs"],
  claude: ["badge", "Claude"],
  codex: ["badge", "Codex"],
  tin: ["tin"],
  candle: ["candle"],
  postgres: ["elephant"],
  forget: ["stamp", "REMEMBERED"],
  pasty: ["pasty"],
  cloudflared: ["cloud"],
  chromium: ["browser"],
  wayland: ["wheel"],
  tokens: ["coins"],
  asks: ["dialog"],
  twice: ["stamp", "SIGNED ✓"],
  cider: ["mugs"],
  gpl20: ["stamp", "GPL-2.0"],
  free: ["stamp", "FREE!"],
  evermore: ["sparkles"],
  vyken: ["sparkles"],
};
interface Prop {
  kind: PropKind;
  label: string;
  at: number;
  x: number;
  y: number;
  seed: number;
}
// (off to the sides, clear of the hamsters in the middle, taking turns left and right)
let propSide = 0;
const props: Prop[] = words.flatMap((w, j) => {
  const found = PROP_WORDS[w.key];
  if (!found) return [];
  const [kind, label = ""] = found;
  const side = propSide++ % 2;
  const x = side ? 0.74 + hash(j) * 0.12 : 0.14 + hash(j) * 0.12;
  return [{ kind, label, at: w.s, x, y: 0.22 + hash(j + 0.5) * 0.2, seed: j }];
});
const PROP_LIFE = 2.6;

const PENZANCE = startsOf(["penzance"]);
const TAMAR = startsOf(["tamar"]);
const CHEEKS = startsOf(["claude", "codex", "cheeks"]);
const LANTERNS = startsOf(["docker", "lanterns", "glow"]);
const FLASH = startsOf(["flash"]);
const LITTER = firstWord("litter")?.s ?? 75;
const FOX = firstWord("fox")?.s ?? 108;
const KEY = firstWord("1password")?.s ?? 119;
const PGVECTOR = firstWord("pgvector")?.s ?? 50;
const CURL = firstWord("curl")?.s ?? 140;
const BASH = firstWord("bash")?.e ?? 143;
const SIGN = firstWord("sign")?.s ?? 145;
const DONE = firstWord("done")?.s ?? 146;
const RAISE = firstWord("raise")?.s ?? 149;
const HIGH = firstWord("high")?.e ?? 151;

const NIBBLE_WORDS = new Set(["nibble", "nibblets", "nibblet", "hamster", "chew", "chewin"]);
const KERNOW_WORDS = new Set([
  "kernow",
  "penzance",
  "tamar",
  "cousin",
  "jack",
  "tin",
  "pasty",
  "cider",
  "bys",
  "vyken",
]);
const TECH_WORDS = new Set([
  "linux",
  "docker",
  "container",
  "thread",
  "heartbeat",
  "claude",
  "codex",
  "postgres",
  "pgvector",
  "cloudflared",
  "chromium",
  "wayland",
  "credproxys",
  "tokens",
  "1password",
  "curl",
  "nibbletsdev",
  "bash",
  "gpl20",
]);
function wordClass(key: string) {
  if (NIBBLE_WORDS.has(key)) return "sa-nib";
  if (KERNOW_WORDS.has(key)) return "sa-kernow";
  if (TECH_WORDS.has(key)) return "sa-tech";
  return "";
}

// Cornish for "well done", "later", "handsome" and "what's going on?"
const SHOUTS = ["Proper job!", "Dreckly!", "'Ansum!", "Wasson?", "Kernow!", "Oggy oggy!", "Nom!"];

// ---------------------------------------------------------------- the stage

let root: HTMLDivElement | undefined;
let cv: HTMLCanvasElement;
let ctx: CanvasRenderingContext2D;
let audio: HTMLAudioElement;
const els: Record<string, HTMLElement> = {};
let W = 0;
let H = 0;
let S = 1;
let dpr = 1;
let sceneAlpha = 1;
let raf = 0;
let dirty = true;
let returnFocus: Element | null = null;

const alpha = (a: number) => (ctx.globalAlpha = sceneAlpha * clamp(a, 0, 1));

function ell(
  x: number,
  y: number,
  rx: number,
  ry: number,
  fill?: string,
  stroke?: string,
  lw = 1,
  rot = 0,
) {
  ctx.beginPath();
  ctx.ellipse(x, y, Math.max(0, rx), Math.max(0, ry), rot, 0, TAU);
  if (stroke) {
    ctx.lineWidth = lw;
    ctx.strokeStyle = stroke;
    ctx.stroke();
  }
  if (fill) {
    ctx.fillStyle = fill;
    ctx.fill();
  }
}
function rrect(x: number, y: number, w: number, h: number, r: number) {
  ctx.beginPath();
  ctx.roundRect(x, y, w, h, r);
}
function glow(x: number, y: number, r: number, colour: string, a: number) {
  if (r <= 0 || a <= 0) return;
  const g = ctx.createRadialGradient(x, y, 0, x, y, r);
  g.addColorStop(0, colour);
  g.addColorStop(1, "rgba(0,0,0,0)");
  ctx.save();
  alpha(a);
  ctx.globalCompositeOperation = "lighter";
  ctx.fillStyle = g;
  ctx.fillRect(x - r, y - r, r * 2, r * 2);
  ctx.restore();
}
function text(
  s: string,
  x: number,
  y: number,
  px: number,
  colour: string,
  weight = 700,
  font = FONT,
) {
  ctx.font = `${weight} ${px}px ${font}`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillStyle = colour;
  ctx.fillText(s, x, y);
}

// ---------------------------------------------------------------- the hamster
// Drawn as the site draws them (src/hamsters), in a 100-unit box, standing at (x, y).

interface Fur {
  fur: string;
  deep: string;
}
const FURS: Fur[] = [
  { fur: "#E9A95E", deep: "#C2803A" },
  { fur: "#CB7841", deep: "#9E5527" },
  { fur: "#F1D3A0", deep: "#C9A56A" },
  { fur: "#B9B0AA", deep: "#8A817B" },
  { fur: "#9A6A4A", deep: "#6E452D" },
  { fur: "#F4C58A", deep: "#CF9450" },
  { fur: "#E3E0DA", deep: "#AFA9A0" },
];
interface HamsterLook {
  fur?: Fur;
  /** how far its mouth is open, 0 to 1 */
  mouth?: number;
  /** how stuffed its cheeks are, 0 to 1 */
  cheeks?: number;
  blink?: boolean;
  hat?: "miner" | "candle";
  lamp?: number;
  tilt?: number;
  /** 0 to 1: a paw in the air */
  wave?: number;
  /** nibbling a seed held in its paws */
  chew?: boolean;
  /** holding a seed (at its teeth when chewing, lower down otherwise, so it can sing) */
  seed?: boolean;
  /** so hamsters chewing side by side aren't in step */
  phase?: number;
  t?: number;
}
function hamster(x: number, y: number, size: number, o: HamsterLook = {}) {
  const f = o.fur ?? FURS[0];
  const t = o.t ?? 0;
  // (a chewing jaw: 0 shut, 1 down; the cheeks bulge with it)
  const phase = o.phase ?? 0;
  const jaw = o.chew ? 0.5 + 0.5 * Math.sin(t * 17 + phase) : 0;
  const c = o.chew ? 0.2 + 0.25 * jaw : clamp(o.cheeks ?? 0, 0, 1);
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(o.tilt ?? 0);
  ctx.scale(size / 100, size / 100);
  ctx.translate(-50, -92);
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  // ears
  for (const ex of [30, 70]) {
    ell(ex, 35, 10, 10, f.fur, f.deep, 2.2);
    ell(ex + (ex < 50 ? -0.5 : 0.5), 35.5, 5.6, 5.6, "#F4AFB4");
  }
  // a paw in the air, behind the body
  if (o.wave) {
    ctx.save();
    ctx.translate(80, 66);
    ctx.rotate(-0.4 - o.wave * 1.2);
    ell(0, -12, 6, 13, f.fur, f.deep, 2);
    ell(0, -22, 4.4, 3.6, "#F4AFB4");
    ctx.restore();
  }
  // body, belly and muzzle
  ell(50, 61, 33, 29, f.fur, f.deep, 4.4);
  ctx.save();
  ctx.beginPath();
  ctx.ellipse(50, 61, 33, 29, 0, 0, TAU);
  ctx.clip();
  ctx.fillStyle = "#FFFDF8";
  ctx.fillRect(10, 68, 80, 11);
  ell(50, 84, 23, 13, "#FFFDF8");
  ctx.restore();
  // stuffed cheeks (with Claude and Codex in them)
  if (c > 0.02) {
    for (const side of [-1, 1]) {
      ell(50 + side * (23 + 5 * c), 63, 9 + 8 * c, 7.5 + 6 * c, f.fur, f.deep, 1.6);
    }
  }
  ell(50, 65 + jaw * 0.8, 12.5, 8.5 - jaw * 0.9, "#FFFDF8");
  ell(41, 40, 11, 5.5, "rgba(255,255,255,0.16)", undefined, 0, -0.31);
  ctx.save();
  ctx.globalAlpha *= 0.45;
  ell(31 - c * 6, 65, 6 + c * 2, 3.8 + c, "#E58B95");
  ell(69 + c * 6, 65, 6 + c * 2, 3.8 + c, "#E58B95");
  ctx.restore();
  // whiskers
  ctx.save();
  ctx.globalAlpha *= 0.75;
  ctx.strokeStyle = f.deep;
  ctx.lineWidth = 0.9;
  ctx.beginPath();
  ctx.moveTo(38, 63);
  ctx.lineTo(22 - c * 6, 60);
  ctx.moveTo(38, 65.5);
  ctx.lineTo(21 - c * 6, 66.5);
  ctx.moveTo(62, 63);
  ctx.lineTo(78 + c * 6, 60);
  ctx.moveTo(62, 65.5);
  ctx.lineTo(79 + c * 6, 66.5);
  ctx.stroke();
  ctx.restore();
  // eyes
  for (const ex of [39, 61]) {
    if (o.blink) {
      ctx.strokeStyle = "#1E1A19";
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(ex - 4.5, 53);
      ctx.quadraticCurveTo(ex, 56, ex + 4.5, 53);
      ctx.stroke();
    } else {
      ell(ex, 53, 5.4, 5.4, "#1E1A19");
      ell(ex + 1.8, 51, 1.9, 1.9, "#FFFFFF");
      ell(ex - 1.7, 55.4, 0.95, 0.95, "#FFFFFF");
    }
  }
  // nose
  ctx.beginPath();
  ctx.moveTo(47.2, 59.4);
  ctx.quadraticCurveTo(50, 57.8, 52.8, 59.4);
  ctx.quadraticCurveTo(51.4, 62, 50, 62.2);
  ctx.quadraticCurveTo(48.6, 62, 47.2, 59.4);
  ctx.fillStyle = "#E58B95";
  ctx.fill();
  // mouth: a smile, or open and singing
  const m = clamp(o.mouth ?? 0, 0, 1);
  if (o.chew) {
    // a little "w" of a mouth, its buck teeth working at the seed
    const dy = jaw * 1.4;
    rrect(48.4, 64.2 + dy * 0.4, 3.2, 3 + dy, 0.6);
    ctx.fillStyle = "#FFFFFF";
    ctx.fill();
    ctx.strokeStyle = "#C9BFB2";
    ctx.lineWidth = 0.5;
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(50, 64.4 + dy * 0.4);
    ctx.lineTo(50, 67.2 + dy * 1.4);
    ctx.stroke();
    ctx.strokeStyle = "#4A2F25";
    ctx.lineWidth = 1.4;
    ctx.beginPath();
    ctx.moveTo(45, 63.4);
    ctx.quadraticCurveTo(47, 65.6 + dy * 0.3, 50, 64.2);
    ctx.quadraticCurveTo(53, 65.6 + dy * 0.3, 55, 63.4);
    ctx.stroke();
  } else if (m > 0.08) {
    ell(50, 66.5, 3 + m * 1.6, 1 + m * 3.6, "#4A2F25");
    ell(50, 67.5 + m * 1.8, 2 + m, 0.8 + m * 1.2, "#E58B95");
  } else {
    ctx.strokeStyle = "#4A2F25";
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(45.5, 64);
    ctx.quadraticCurveTo(50, 68.5, 54.5, 64);
    ctx.stroke();
  }
  // paws and feet
  for (const [px, py, rx, ry] of [
    [42.5, 77, 4.2, 3.2],
    [57.5, 77, 4.2, 3.2],
    [38, 89.5, 5, 3],
    [62, 89.5, 5, 3],
  ]) {
    if ((o.wave && px === 57.5) || ((o.chew || o.seed) && py === 77)) continue;
    ell(px, py, rx, ry, "#F4AFB4", "#E58B95", 0.8);
  }
  if (o.chew || o.seed) {
    // the seed, held up to its teeth, wobbling as it's nibbled (and crumbs falling), or held
    // lower down while it sings
    const sy = o.chew ? 74 + jaw * 0.8 : 80;
    ctx.save();
    ctx.translate(50, sy);
    ctx.rotate(0.3 + Math.sin(t * 17 + phase) * 0.06);
    ctx.beginPath();
    ctx.moveTo(0, -8.5);
    ctx.quadraticCurveTo(7.2, -1, 0, 8);
    ctx.quadraticCurveTo(-7.2, -1, 0, -8.5);
    ctx.fillStyle = "#3E3A3A";
    ctx.fill();
    ctx.strokeStyle = "#2A2626";
    ctx.lineWidth = 0.8;
    ctx.stroke();
    ctx.strokeStyle = "#E8E1D3";
    ctx.lineWidth = 0.9;
    ctx.beginPath();
    ctx.moveTo(-1.5, -5.5);
    ctx.quadraticCurveTo(-2.2, 0, -1.4, 5.5);
    ctx.moveTo(1.5, -5.5);
    ctx.quadraticCurveTo(2.2, 0, 1.4, 5.5);
    ctx.stroke();
    ctx.restore();
    ell(44.2, sy + 1.5, 3.4, 2.8, "#F4AFB4", "#E58B95", 0.8);
    ell(55.8, sy + 1.5, 3.4, 2.8, "#F4AFB4", "#E58B95", 0.8);
    for (let i = 0; i < (o.chew ? 3 : 0); i++) {
      const k = (t * 1.6 + i / 3) % 1;
      ell(48 + hash(i + Math.floor(t * 1.6 + i / 3)) * 4, 75 + k * 14, 0.7, 0.7, "#D9B26A");
    }
  }
  // hats
  if (o.hat === "miner") {
    ctx.beginPath();
    ctx.ellipse(50, 37, 24, 16, 0, Math.PI, 0);
    ctx.closePath();
    ctx.fillStyle = "#F2C230";
    ctx.fill();
    ctx.strokeStyle = "#B8860B";
    ctx.lineWidth = 1.6;
    ctx.stroke();
    rrect(22, 34, 56, 5, 2.5);
    ctx.fillStyle = "#E0AE1C";
    ctx.fill();
    ctx.stroke();
    ell(50, 27, 5.4, 5.4, "#7A5A12");
    ell(50, 27, 3.8, 3.8, "#FFF6C8");
    const lamp = o.lamp ?? 1;
    ctx.restore();
    // (the lamp's light, outside the hamster's own scale so it reaches)
    glow(
      x,
      y - size * 0.65,
      size * (0.35 + 0.25 * lamp),
      "rgba(255,240,170,0.9)",
      0.5 + 0.4 * lamp,
    );
    return;
  }
  if (o.hat === "candle") {
    ctx.beginPath();
    ctx.ellipse(50, 37, 23, 15, 0, Math.PI, 0);
    ctx.closePath();
    ctx.fillStyle = "#6B4A2E";
    ctx.fill();
    rrect(23, 34, 54, 5, 2.5);
    ctx.fillStyle = "#5A3C24";
    ctx.fill();
    // a lump of clay, a candle in it, and its flame
    ell(50, 23, 6, 3.5, "#9C7A55");
    rrect(47, 9, 6, 14, 1.5);
    ctx.fillStyle = "#FFF4DC";
    ctx.fill();
    const fl = 1 + 0.18 * Math.sin(t * 23) + 0.1 * Math.sin(t * 37);
    ctx.beginPath();
    ctx.moveTo(50, 8.5 - 9 * fl);
    ctx.quadraticCurveTo(55, 3, 50, 8.5);
    ctx.quadraticCurveTo(45, 3, 50, 8.5 - 9 * fl);
    ctx.fillStyle = "#FFB43C";
    ctx.fill();
    ell(50, 5.5, 1.6, 2.6, "#FFF4C0");
    ctx.restore();
    glow(x, y - size * 0.94, size * 0.45 * fl, "rgba(255,190,90,0.9)", 0.6);
    return;
  }
  ctx.restore();
}

// ---------------------------------------------------------------- bits of scenery

function sky(top: string, mid: string, bottom: string, to = H * 0.66) {
  const g = ctx.createLinearGradient(0, 0, 0, to);
  g.addColorStop(0, top);
  g.addColorStop(0.55, mid);
  g.addColorStop(1, bottom);
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, W, H);
}

function stars(n: number, seed: number, t: number, maxY: number) {
  ctx.save();
  for (let i = 0; i < n; i++) {
    const x = hash(seed + i) * W;
    const y = hash(seed + i * 1.7 + 3) * maxY;
    const r = (0.6 + hash(i * 3.3) * 1.4) * Math.max(1, S * 0.12);
    alpha(0.35 + 0.65 * Math.abs(Math.sin(t * (0.6 + hash(i) * 1.6) + i)));
    ell(x, y, r, r, "#FFF7E0");
  }
  ctx.restore();
}

function sea(horizon: number, cols: [string, string, string], t: number) {
  ctx.fillStyle = cols[0];
  ctx.fillRect(0, horizon, W, H - horizon);
  for (let j = 0; j < 4; j++) {
    const y0 = horizon + (H - horizon) * (0.12 + j * 0.22);
    const amp = S * (0.35 + j * 0.3);
    ctx.beginPath();
    ctx.moveTo(0, H);
    for (let x = 0; x <= W + 20; x += 16) {
      ctx.lineTo(x, y0 + Math.sin(x / (S * (5 + j * 2)) + t * (1.2 + j * 0.4) + j) * amp);
    }
    ctx.lineTo(W, H);
    ctx.closePath();
    ctx.fillStyle = j % 2 ? cols[2] : cols[1];
    ctx.fill();
  }
}

/** A Cornish engine house, its chimney beside it; returns the chimney's top. */
function engineHouse(x: number, ground: number, s: number, wall: string, dark: string) {
  const w = 11 * s;
  const h = 11 * s;
  ctx.fillStyle = wall;
  ctx.fillRect(x, ground - h, w, h);
  ctx.beginPath();
  ctx.moveTo(x - 0.6 * s, ground - h);
  ctx.lineTo(x + w / 2, ground - h - 4.5 * s);
  ctx.lineTo(x + w + 0.6 * s, ground - h);
  ctx.closePath();
  ctx.fill();
  // its windows: arched, and empty
  ctx.fillStyle = dark;
  for (const [wx, wy, ww, wh] of [
    [x + w / 2 - 1.5 * s, ground - h + 2 * s, 3 * s, 5 * s],
    [x + 1.6 * s, ground - h + 3 * s, 2 * s, 3.2 * s],
    [x + w - 3.6 * s, ground - h + 3 * s, 2 * s, 3.2 * s],
  ]) {
    ctx.beginPath();
    ctx.moveTo(wx, wy + wh);
    ctx.lineTo(wx, wy + ww / 2);
    ctx.arc(wx + ww / 2, wy + ww / 2, ww / 2, Math.PI, 0);
    ctx.lineTo(wx + ww, wy + wh);
    ctx.closePath();
    ctx.fill();
  }
  // the chimney
  const cx = x + w + 1.4 * s;
  const top = ground - 28 * s;
  ctx.fillStyle = wall;
  ctx.beginPath();
  ctx.moveTo(cx - 1.8 * s, ground);
  ctx.lineTo(cx - 1.2 * s, top);
  ctx.lineTo(cx + 1.2 * s, top);
  ctx.lineTo(cx + 1.8 * s, ground);
  ctx.closePath();
  ctx.fill();
  ctx.fillStyle = dark;
  ctx.globalAlpha *= 0.45;
  ctx.fillRect(cx - 1.25 * s, top, 2.5 * s, 3.5 * s);
  ctx.globalAlpha /= 0.45;
  return { x: cx, y: top };
}

/** St Piran's flag, white cross on black, flapping. (x, y) is its top-left, at the pole. */
function piran(x: number, y: number, w: number, h: number, t: number) {
  const n = 22;
  const bar = h * 0.2;
  for (let i = 0; i < n; i++) {
    const k = i / n;
    const dy = Math.sin(t * 5 - k * 5) * h * 0.12 * k;
    const sx = x + k * w;
    const sw = w / n + 0.8;
    ctx.fillStyle = "#151515";
    ctx.fillRect(sx, y + dy, sw, h);
    ctx.fillStyle = "#FFFFFF";
    ctx.fillRect(sx, y + dy + h / 2 - bar / 2, sw, bar);
    if (Math.abs(k + 0.5 / n - 0.5) < bar / w / 2 + 0.5 / n) ctx.fillRect(sx, y + dy, sw, h);
  }
}

function bunting(y: number, t: number, kick: number) {
  const n = Math.max(8, Math.round(W / (S * 6)));
  const sag = S * 1.2;
  const pts = (k: number) => ({ x: k * W, y: y + Math.sin(k * Math.PI) * sag });
  ctx.strokeStyle = "rgba(255,255,255,0.6)";
  ctx.lineWidth = Math.max(1, S * 0.15);
  ctx.beginPath();
  for (let i = 0; i <= 40; i++) {
    const p = pts(i / 40);
    if (i) ctx.lineTo(p.x, p.y);
    else ctx.moveTo(p.x, p.y);
  }
  ctx.stroke();
  const cols = ["#151515", "#FFFFFF", "#F2C230"];
  for (let i = 0; i < n; i++) {
    const k = (i + 0.5) / n;
    const p = pts(k);
    const swing = Math.sin(t * 2.4 + i) * 0.12 + kick * 0.15 * (i % 2 ? 1 : -1);
    ctx.save();
    ctx.translate(p.x, p.y);
    ctx.rotate(swing);
    ctx.beginPath();
    ctx.moveTo(-S * 1.6, 0);
    ctx.lineTo(S * 1.6, 0);
    ctx.lineTo(0, S * 3.4);
    ctx.closePath();
    ctx.fillStyle = cols[i % 3];
    ctx.fill();
    ctx.restore();
  }
}

function gulls(t: number, top: number) {
  ctx.strokeStyle = "rgba(255,255,255,0.85)";
  ctx.lineWidth = Math.max(1.2, S * 0.28);
  for (let i = 0; i < 4; i++) {
    const x = (((t * (0.025 + hash(i) * 0.02) + hash(i + 4)) % 1.2) - 0.1) * W;
    const y = top + S * (hash(i + 5) * 9) + Math.sin(t * 1.4 + i) * S;
    const flap = Math.sin(t * 7 + i * 2) * S * 0.8;
    const s = S * (1.3 + hash(i + 2) * 0.8);
    ctx.beginPath();
    ctx.moveTo(x - s, y - flap * 0.6);
    ctx.quadraticCurveTo(x - s * 0.4, y - s * 0.5 - flap, x, y);
    ctx.quadraticCurveTo(x + s * 0.4, y - s * 0.5 - flap, x + s, y - flap * 0.6);
    ctx.stroke();
  }
}

function fireworks(t: number, from: number, every: number) {
  const b = beatAt(t);
  ctx.save();
  ctx.globalCompositeOperation = "lighter";
  const cols = ["#FFD27A", "#FFFFFF", "#FF9A7A", "#9ED8FF", "#F7A8D8"];
  for (let i = Math.max(0, b.i - every * 3); i <= b.i; i++) {
    if (i % every || beats[i] < from) continue;
    const age = t - beats[i];
    if (age < 0 || age > 1.8) continue;
    const x = (0.12 + hash(i) * 0.76) * W;
    const y = (0.12 + hash(i + 0.3) * 0.26) * H;
    const col = cols[i % cols.length];
    const n = calm ? 14 : 28;
    const r = out3(age / 1.1) * S * (9 + hash(i + 2) * 5);
    for (let k = 0; k < n; k++) {
      const a = (k / n) * TAU + hash(i);
      const px = x + Math.cos(a) * r;
      const py = y + Math.sin(a) * r + age * age * S * 3;
      alpha((1 - age / 1.8) * 0.9);
      ell(px, py, S * 0.35, S * 0.35, col);
    }
    alpha(Math.max(0, 0.35 - age * 0.5));
    ell(x, y, S * 2.5, S * 2.5, "#FFFFFF");
  }
  ctx.restore();
}

// ---------------------------------------------------------------- the props

function prop(p: Prop, t: number) {
  const age = t - p.at;
  if (age < -0.02 || age > PROP_LIFE) return;
  const k = back(age / 0.35);
  const fade = 1 - clamp((age - (PROP_LIFE - 0.5)) / 0.5, 0, 1);
  const x = p.x * W;
  const y = p.y * H - age * S * 1.4;
  const s = S * 9 * k;
  ctx.save();
  alpha(fade);
  ctx.translate(x, y);
  ctx.rotate(Math.sin(age * 3 + p.seed) * 0.08);
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  switch (p.kind) {
    case "heart": {
      const beat = 1 + 0.15 * Math.abs(Math.sin(age * 9));
      ctx.scale(beat, beat);
      ctx.beginPath();
      ctx.moveTo(0, s * 0.35);
      ctx.bezierCurveTo(-s * 0.9, -s * 0.2, -s * 0.45, -s * 0.8, 0, -s * 0.35);
      ctx.bezierCurveTo(s * 0.45, -s * 0.8, s * 0.9, -s * 0.2, 0, s * 0.35);
      ctx.fillStyle = "#FF6F7D";
      ctx.fill();
      ell(-s * 0.3, -s * 0.35, s * 0.12, s * 0.08, "rgba(255,255,255,0.6)", undefined, 0, -0.6);
      break;
    }
    case "crumbs": {
      for (let i = 0; i < 14; i++) {
        const a = hash(p.seed + i) * TAU;
        const d = out3(age / 0.8) * S * (4 + hash(i + p.seed) * 6);
        const r = S * (0.3 + hash(i * 2 + p.seed) * 0.5);
        ell(
          Math.cos(a) * d,
          Math.sin(a) * d + age * age * S * 4,
          r,
          r,
          i % 2 ? "#E9B65A" : "#C88A34",
        );
      }
      ctx.rotate(-0.15);
      text("nom!", 0, 0, S * 2.4 * k, "#FFE7C2");
      break;
    }
    case "badge":
    case "stamp": {
      const stamp = p.kind === "stamp";
      ctx.font = `700 ${S * 2.6}px ${stamp ? FONT : MONO}`;
      const tw = ctx.measureText(p.label).width + S * 3;
      ctx.scale(k, k);
      if (stamp) ctx.rotate(-0.12);
      rrect(-tw / 2, -S * 2.2, tw, S * 4.4, stamp ? S * 0.8 : S * 2.2);
      ctx.fillStyle = stamp ? "rgba(255,250,242,0.95)" : "#2B2A33";
      ctx.fill();
      ctx.lineWidth = S * 0.4;
      ctx.strokeStyle = stamp ? "#C2412D" : "#9ED8FF";
      ctx.stroke();
      text(p.label, 0, S * 0.15, S * 2.6, stamp ? "#C2412D" : "#9ED8FF", 700, stamp ? FONT : MONO);
      break;
    }
    case "flag": {
      ctx.scale(k, k);
      ctx.fillStyle = "#D8D2C8";
      ctx.fillRect(-s * 0.62, -s * 0.5, s * 0.06, s * 1.3);
      piran(-s * 0.58, -s * 0.5, s * 1.2, s * 0.75, t);
      break;
    }
    case "pasty":
      pasty(0, 0, s, 0);
      break;
    case "elephant": {
      // a blue elephant: the one who never forgets
      ell(-s * 0.55, 0, s * 0.45, s * 0.55, "#4F7DB0", "#2F5A8A", S * 0.3);
      ell(s * 0.55, 0, s * 0.45, s * 0.55, "#4F7DB0", "#2F5A8A", S * 0.3);
      ell(0, -s * 0.05, s * 0.5, s * 0.5, "#6A98CC", "#2F5A8A", S * 0.3);
      ctx.strokeStyle = "#6A98CC";
      ctx.lineWidth = s * 0.22;
      ctx.beginPath();
      ctx.moveTo(0, s * 0.15);
      ctx.quadraticCurveTo(0, s * 0.8, s * 0.35, s * 0.7);
      ctx.stroke();
      ell(-s * 0.18, -s * 0.12, s * 0.07, s * 0.08, "#1E1A19");
      ell(s * 0.18, -s * 0.12, s * 0.07, s * 0.08, "#1E1A19");
      break;
    }
    case "candle": {
      rrect(-s * 0.15, -s * 0.2, s * 0.3, s * 0.8, s * 0.05);
      ctx.fillStyle = "#FFF4DC";
      ctx.fill();
      const fl = 1 + 0.2 * Math.sin(t * 20);
      ell(0, -s * 0.38, s * 0.12, s * 0.2 * fl, "#FFB43C");
      ctx.restore();
      glow(x, y - s * 0.4, s * 1.2, "rgba(255,190,90,0.9)", fade * 0.7);
      return;
    }
    case "tin": {
      ctx.scale(k, k);
      ctx.beginPath();
      ctx.moveTo(-S * 5, S * 1.5);
      ctx.lineTo(-S * 3.5, -S * 1.5);
      ctx.lineTo(S * 3.5, -S * 1.5);
      ctx.lineTo(S * 5, S * 1.5);
      ctx.closePath();
      ctx.fillStyle = "#C9CED6";
      ctx.fill();
      ctx.strokeStyle = "#8A919C";
      ctx.lineWidth = S * 0.3;
      ctx.stroke();
      const shine = ((age * 1.2) % 1) * S * 10 - S * 5;
      alpha(fade * 0.8);
      ctx.fillStyle = "#FFFFFF";
      ctx.fillRect(shine, -S * 1.4, S * 0.8, S * 2.8);
      alpha(fade);
      text("Sn", 0, 0, S * 1.8, "#5E6670");
      break;
    }
    case "cloud": {
      ctx.translate(-S * 8 + age * S * 6, 0);
      for (const [cx, cy, r] of [
        [-1.6, 0.3, 1.5],
        [0, -0.5, 2.1],
        [1.8, 0.2, 1.6],
        [0.2, 0.7, 1.6],
      ]) {
        ell(cx * S * 1.6, cy * S * 1.6, r * S * 1.6, r * S * 1.6, "#F6A04D");
      }
      ctx.strokeStyle = "rgba(255,255,255,0.7)";
      ctx.lineWidth = S * 0.3;
      for (let i = 0; i < 3; i++) {
        ctx.beginPath();
        ctx.moveTo(-S * (7 + i), S * (i - 1) * 1.4);
        ctx.lineTo(-S * (4.5 + i * 0.5), S * (i - 1) * 1.4);
        ctx.stroke();
      }
      break;
    }
    case "browser": {
      ctx.scale(k, k);
      const w = S * 16;
      const h = S * 11;
      rrect(-w / 2, -h / 2, w, h, S);
      ctx.fillStyle = "#FFFFFF";
      ctx.fill();
      ctx.fillStyle = "#E7E2D8";
      ctx.fillRect(-w / 2, -h / 2 + S * 0.5, w, S * 1.8);
      ["#FF6F61", "#F2C230", "#6CC56C"].forEach((c, i) =>
        ell(-w / 2 + S * (1.4 + i * 1.3), -h / 2 + S * 1.4, S * 0.45, S * 0.45, c),
      );
      rrect(-w / 2 + S * 5, -h / 2 + S * 0.8, w - S * 6, S * 1.2, S * 0.6);
      ctx.fillStyle = "#FFFFFF";
      ctx.fill();
      ctx.save();
      ctx.beginPath();
      ctx.rect(-w / 2, -h / 2 + S * 2.3, w, h - S * 2.3);
      ctx.clip();
      ctx.fillStyle = "#DCEBFA";
      ctx.fillRect(-w / 2, -h / 2 + S * 2.3, w, h);
      hamster(0, h / 2 + S * 1.5, S * 9, {
        t,
        mouth: 0.4 + 0.4 * Math.sin(t * 12),
        wave: 0.5 + 0.5 * Math.sin(t * 8),
      });
      ctx.restore();
      break;
    }
    case "wheel": {
      ctx.scale(k, k);
      ctx.rotate(age * 2.4);
      ctx.strokeStyle = "#8A5A30";
      ctx.lineWidth = S * 1;
      ell(0, 0, S * 4, S * 4, undefined, "#8A5A30", S * 1);
      for (let i = 0; i < 8; i++) {
        const a = (i / 8) * TAU;
        ctx.beginPath();
        ctx.moveTo(0, 0);
        ctx.lineTo(Math.cos(a) * S * 5.6, Math.sin(a) * S * 5.6);
        ctx.stroke();
        ell(Math.cos(a) * S * 5.8, Math.sin(a) * S * 5.8, S * 0.6, S * 0.6, "#8A5A30");
      }
      ell(0, 0, S * 1.2, S * 1.2, "#C28A50");
      break;
    }
    case "coins": {
      for (let i = 0; i < 6; i++) {
        const cy = S * 2.5 - i * S * 0.9 * k;
        ell(0, cy, S * 2.8, S * 1, "#F2C230", "#B8860B", S * 0.25);
      }
      glow(0, -S * 2, S * 4, "rgba(255,220,120,0.9)", 0.25 + 0.1 * Math.sin(age * 2));
      break;
    }
    case "mugs": {
      ctx.scale(k, k);
      const clink = Math.sin(clamp(age / 0.5, 0, 1) * Math.PI) * 0.25;
      for (const side of [-1, 1]) {
        ctx.save();
        ctx.translate(side * S * 3, 0);
        ctx.rotate(-side * (0.15 + clink));
        mug(0, 0, S * 4);
        ctx.restore();
      }
      break;
    }
    case "sparkles": {
      for (let i = 0; i < 9; i++) {
        const a = hash(p.seed * 3 + i) * TAU;
        const d = out3(age / 1) * S * (3 + hash(i) * 8);
        const r = S * (0.8 + hash(i + 1) * 1.2) * (1 - age / PROP_LIFE);
        sparkle(Math.cos(a) * d, Math.sin(a) * d, r, i % 2 ? "#FFE08A" : "#FFFFFF");
      }
      break;
    }
    case "dialog": {
      ctx.scale(k, k);
      const w = S * 19;
      const h = S * 9;
      rrect(-w / 2, -h / 2, w, h, S * 1.2);
      ctx.fillStyle = "#FFFDF8";
      ctx.fill();
      text("Allow this tool?", 0, -h / 2 + S * 2.4, S * 2, "#2B2A33");
      const yes = age > 1.2;
      rrect(-w / 2 + S * 1.5, S * 0.6, w / 2 - S * 2.2, S * 2.8, S * 1.4);
      ctx.fillStyle = yes ? "#E9A95E" : "#F3EDE3";
      ctx.fill();
      text("Allow", -w / 4 + S * 0.35, S * 2, S * 1.6, "#3B2412");
      rrect(S * 0.7, S * 0.6, w / 2 - S * 2.2, S * 2.8, S * 1.4);
      ctx.fillStyle = "#F3EDE3";
      ctx.fill();
      text("Deny", w / 4 - S * 0.35, S * 2, S * 1.6, "#5E6070");
      break;
    }
  }
  ctx.restore();
}

function pasty(x: number, y: number, s: number, rot: number) {
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(rot);
  const g = ctx.createLinearGradient(0, -s * 0.6, 0, s * 0.2);
  g.addColorStop(0, "#F2C46A");
  g.addColorStop(1, "#C8862E");
  ctx.beginPath();
  ctx.moveTo(-s * 0.7, s * 0.15);
  ctx.ellipse(0, s * 0.15, s * 0.7, s * 0.6, 0, Math.PI, 0);
  ctx.closePath();
  ctx.fillStyle = g;
  ctx.fill();
  ctx.strokeStyle = "#9A5F1E";
  ctx.lineWidth = Math.max(1, s * 0.05);
  ctx.stroke();
  // the crimp, along the top
  for (let i = 0; i <= 8; i++) {
    const a = Math.PI + (i / 8) * Math.PI;
    ell(
      Math.cos(a) * s * 0.66,
      s * 0.15 + Math.sin(a) * s * 0.56,
      s * 0.1,
      s * 0.08,
      "#E0A548",
      "#9A5F1E",
      Math.max(0.8, s * 0.03),
      a,
    );
  }
  ell(-s * 0.2, -s * 0.12, s * 0.16, s * 0.06, "rgba(255,255,255,0.35)", undefined, 0, -0.4);
  ctx.restore();
}

function mug(x: number, y: number, s: number) {
  rrect(x - s * 0.4, y - s * 0.6, s * 0.8, s * 1.1, s * 0.12);
  ctx.fillStyle = "#F0A93A";
  ctx.fill();
  ctx.strokeStyle = "rgba(255,255,255,0.75)";
  ctx.lineWidth = Math.max(1, s * 0.07);
  ctx.stroke();
  ell(x, y - s * 0.62, s * 0.42, s * 0.14, "#FFF6E0");
  ell(
    x + s * 0.55,
    y - s * 0.05,
    s * 0.18,
    s * 0.28,
    undefined,
    "rgba(255,255,255,0.75)",
    Math.max(1, s * 0.08),
  );
}

/** A gold key, its bow at (x, y), `u` to a unit, turned `rot` from lying to the right. */
function key(x: number, y: number, u: number, rot: number) {
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(rot);
  ell(0, 0, u * 2, u * 2, undefined, "#F2C230", u * 1.1);
  ctx.fillStyle = "#F2C230";
  ctx.fillRect(u * 1.8, -u * 0.55, u * 6.5, u * 1.1);
  ctx.fillRect(u * 6.6, 0, u * 0.9, u * 1.8);
  ctx.fillRect(u * 5, 0, u * 0.9, u * 1.4);
  ctx.restore();
}

function sparkle(x: number, y: number, r: number, colour: string) {
  if (r <= 0) return;
  ctx.beginPath();
  ctx.moveTo(x, y - r);
  ctx.quadraticCurveTo(x, y, x + r, y);
  ctx.quadraticCurveTo(x, y, x, y + r);
  ctx.quadraticCurveTo(x, y, x - r, y);
  ctx.quadraticCurveTo(x, y, x, y - r);
  ctx.fillStyle = colour;
  ctx.fill();
}

function fox(x: number, y: number, size: number, t: number, kick: number) {
  ctx.save();
  ctx.translate(x, y);
  ctx.scale(size / 100, size / 100);
  ctx.translate(-50, -100);
  ctx.lineJoin = "round";
  // tail, swishing
  ctx.save();
  ctx.translate(66, 92);
  ctx.rotate(Math.sin(t * 2.2) * 0.18);
  ctx.beginPath();
  ctx.moveTo(0, 0);
  ctx.bezierCurveTo(30, 4, 40, -20, 30, -44);
  ctx.bezierCurveTo(22, -26, 10, -14, -6, -8);
  ctx.closePath();
  ctx.fillStyle = "#E8742F";
  ctx.fill();
  ell(29, -40, 6, 8, "#FFF4E6", undefined, 0, 0.4);
  ctx.restore();
  // body and chest
  ell(56, 74, 22, 22, "#E8742F");
  ell(46, 76, 10, 15, "#FFF4E6");
  ell(44, 97, 5, 3, "#2B1A14");
  ell(58, 97, 5, 3, "#2B1A14");
  // head, ears (twitching on the beat) and snout
  const tw = kick * 0.2;
  for (const [bx, tx, rot] of [
    [30, 26, -tw],
    [46, 50, tw],
  ]) {
    ctx.save();
    ctx.translate(bx, 30);
    ctx.rotate(rot);
    ctx.beginPath();
    ctx.moveTo(-6, 2);
    ctx.lineTo(tx - bx, -18);
    ctx.lineTo(6, 2);
    ctx.closePath();
    ctx.fillStyle = "#E8742F";
    ctx.fill();
    ctx.beginPath();
    ctx.moveTo(-3, 0);
    ctx.lineTo((tx - bx) * 0.8, -12);
    ctx.lineTo(3, 0);
    ctx.fillStyle = "#3A2018";
    ctx.fill();
    ctx.restore();
  }
  ell(38, 44, 16, 15, "#E8742F");
  ctx.beginPath();
  ctx.moveTo(26, 40);
  ctx.lineTo(8, 52);
  ctx.lineTo(30, 58);
  ctx.closePath();
  ctx.fillStyle = "#E8742F";
  ctx.fill();
  ctx.beginPath();
  ctx.moveTo(10, 52);
  ctx.lineTo(30, 58);
  ctx.lineTo(38, 52);
  ctx.closePath();
  ctx.fillStyle = "#FFF4E6";
  ctx.fill();
  ell(9, 51, 2.6, 2.4, "#1E1A19");
  // a sly eye, glinting
  ell(30, 41, 3.4, 2.2, "#1E1A19", undefined, 0, -0.3);
  ell(31, 40.4, 1, 0.8, "#FFE08A");
  ctx.restore();
}

// ---------------------------------------------------------------- the scenes

interface CliffLook {
  sky: [string, string, string];
  sea: [string, string, string];
  rock: string;
  grass: string;
  wall: string;
  night?: boolean;
  sun?: string;
  dancers: number;
  bunting?: boolean;
  fireworks?: number;
  title?: string;
}
const DAWN: Omit<CliffLook, "dancers"> = {
  sky: ["#2B2350", "#B5658A", "#F7C08A"],
  sea: ["#3E5C8A", "#35517C", "#2B456C"],
  rock: "#5A4A42",
  grass: "#6E9A4C",
  wall: "#4A3D38",
  sun: "#FFE1A0",
};
const GOLDEN: Omit<CliffLook, "dancers"> = {
  sky: ["#3A1F4A", "#D0607A", "#FFB86B"],
  sea: ["#4A6FA0", "#3F6292", "#33547F"],
  rock: "#6B4E3D",
  grass: "#7FAF4F",
  wall: "#4E3A30",
  sun: "#FFE9B0",
};
const NIGHT: Omit<CliffLook, "dancers"> = {
  sky: ["#070B26", "#18205A", "#33357A"],
  sea: ["#1D2C55", "#18264C", "#132042"],
  rock: "#2A2433",
  grass: "#2F4A3A",
  wall: "#1C1824",
  night: true,
};

function cliffs(t: number, o: CliffLook) {
  const horizon = H * 0.56;
  const ground = H * 0.7;
  const b = beatAt(t);
  sky(o.sky[0], o.sky[1], o.sky[2], horizon);
  if (o.night) {
    stars(90, 1, t, horizon);
    const mx = W * 0.74;
    const my = H * 0.2;
    glow(mx, my, S * 22, "rgba(200,210,255,0.5)", 0.55 + swell(t) * 0.1);
    ell(mx, my, S * 5, S * 5, "#F4F1E4");
    ell(mx - S * 1.4, my - S * 1, S * 1, S * 1, "rgba(0,0,0,0.08)");
  } else if (o.sun) {
    const sx = W * 0.68;
    const sy = horizon - S * 4 - Math.min(t, 10) * S * 0.3;
    glow(sx, sy, S * 30, "rgba(255,200,120,0.55)", 0.8);
    ell(sx, sy, S * 6.5, S * 6.5, o.sun);
  }
  sea(horizon, o.sea, t);
  if (o.sun && !o.night) {
    // the sun on the water
    ctx.save();
    for (let i = 0; i < 9; i++) {
      const y = horizon + S * (1 + i * 1.6);
      const w = S * (6 - i * 0.4) * (1 + 0.3 * Math.sin(t * 3 + i));
      alpha(0.5 - i * 0.04);
      ctx.fillStyle = o.sun;
      ctx.fillRect(W * 0.68 - w / 2, y, w, S * 0.35);
    }
    ctx.restore();
  }
  if (!o.night) gulls(t, H * 0.12);
  // the cliff, the engine house on it, and St Piran's flag on its chimney
  const top = horizon - S * 10;
  ctx.beginPath();
  ctx.moveTo(0, H);
  ctx.lineTo(0, top - S * 2);
  ctx.lineTo(W * 0.14, top - S * 2.5);
  ctx.lineTo(W * 0.26, top);
  ctx.lineTo(W * 0.31, horizon - S * 3);
  ctx.lineTo(W * 0.34, horizon + S * 4);
  ctx.lineTo(W * 0.3, H);
  ctx.closePath();
  ctx.fillStyle = o.rock;
  ctx.fill();
  ctx.strokeStyle = o.grass;
  ctx.lineWidth = S * 1.4;
  ctx.beginPath();
  ctx.moveTo(0, top - S * 2);
  ctx.lineTo(W * 0.14, top - S * 2.5);
  ctx.lineTo(W * 0.26, top);
  ctx.stroke();
  const chimney = engineHouse(
    W * 0.06,
    top - S * 2.2,
    S * 0.8,
    o.wall,
    o.night ? "#0A0812" : "#2A1E1A",
  );
  ctx.fillStyle = "#D8D2C8";
  ctx.fillRect(chimney.x - S * 0.15, chimney.y - S * 6, S * 0.3, S * 6);
  piran(chimney.x, chimney.y - S * 6, S * 6, S * 3.8, t);
  signpost(W * 0.21, top - S * 1.2, t);
  if (o.title) {
    // (in the open sky right of the cliff, as big as fits there, over everything behind it)
    ctx.save();
    ctx.shadowColor = "rgba(0,0,0,0.3)";
    ctx.shadowBlur = S * 2;
    ctx.font = `700 100px ${FONT}`;
    const px = Math.min(S * 8, (W * 0.56 * 100) / ctx.measureText(o.title).width);
    text(o.title, W * 0.65, H * 0.3, px, "#FFFFFF");
    ctx.restore();
  }
  if (o.fireworks) fireworks(t, 0, o.fireworks);
  if (o.bunting) bunting(-S * 0.5, t, b.kick);
  // the near hill, and the hamsters dancing on it
  ctx.beginPath();
  ctx.moveTo(0, H);
  ctx.lineTo(0, ground + S * 2);
  ctx.quadraticCurveTo(W * 0.5, ground - S * 4, W, ground + S * 1);
  ctx.lineTo(W, H);
  ctx.closePath();
  ctx.fillStyle = o.night ? "#22382C" : o.grass;
  ctx.fill();
  layerProps();
  dancers(t, o.dancers, ground, !!o.night);
}

/** A signpost on the clifftop: Penzance one way, the Tamar the other, each up as it's sung. */
function signpost(x: number, ground: number, t: number) {
  // (a board stays up for the rest of its chorus)
  const since = (starts: number[]) => {
    let best = -1;
    for (const s of starts) if (s <= t && t - s < 9) best = t - s;
    return best;
  };
  const boards: [string, number, number][] = [
    ["PENZANCE", -1, since(PENZANCE)],
    ["TAMAR", 1, since(TAMAR)],
  ];
  if (boards.every(([, , age]) => age < 0)) return;
  const px = S * 1.6;
  ctx.save();
  ctx.lineJoin = "round";
  ctx.fillStyle = "#7A5230";
  ctx.fillRect(x - S * 0.5, ground - S * 11, S, S * 11);
  boards.forEach(([label, dir, age], i) => {
    if (age < 0) return;
    const k = back(age / 0.35);
    ctx.font = `700 ${px}px ${FONT}`;
    const w = ctx.measureText(label).width + S * 2.4;
    const h = S * 2.8;
    const point = S * 1.3;
    const y = ground - S * (10 - i * 3.6);
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(dir * 0.04);
    ctx.scale(k, k);
    // the board starts at the post and points away from it
    const near = dir * S * 0.2;
    const far = near + dir * w;
    ctx.beginPath();
    ctx.moveTo(near, -h / 2);
    ctx.lineTo(far, -h / 2);
    ctx.lineTo(far + dir * point, 0);
    ctx.lineTo(far, h / 2);
    ctx.lineTo(near, h / 2);
    ctx.closePath();
    ctx.fillStyle = "#FFF4DC";
    ctx.fill();
    ctx.strokeStyle = "#7A5230";
    ctx.lineWidth = S * 0.3;
    ctx.stroke();
    text(label, (near + far) / 2, S * 0.1, px, "#3B2412");
    ctx.restore();
  });
  ctx.restore();
}

function dancers(t: number, n: number, ground: number, night: boolean) {
  const b = beatAt(t);
  const singing = clamp(env(t, 3) * 1.6, 0, 1);
  const chewing = n === 1 || !lines.some((l) => t >= l.s - 0.3 && t <= l.e + 0.3);
  const cheeks = recent(CHEEKS, t, 1.6);
  const gap = Math.min(W * 0.17, (W * 0.84) / Math.max(1, n - 1));
  const size = Math.min(S * (n > 5 ? 13 : 15), gap * 1.05);
  for (let i = 0; i < n; i++) {
    const x = W / 2 + (i - (n - 1) / 2) * gap;
    const yAt = ground - S * 1.5 + Math.pow((x - W / 2) / W, 2) * S * 10;
    const step = (b.i + b.phase + (i % 2) * 0.5) * Math.PI;
    const hop = calm ? 0 : Math.abs(Math.sin(step)) * S * 1.6;
    const tilt = calm ? 0 : Math.sin(step) * 0.12;
    hamster(x, yAt - hop, size, {
      fur: FURS[i % FURS.length],
      t,
      mouth: chewing ? 0 : singing * (0.6 + 0.4 * hash(i + Math.floor(t * 6))),
      chew: chewing,
      seed: true,
      phase: i * 1.3,
      cheeks,
      tilt,
      hat: n === 1 ? "miner" : undefined,
      blink: night ? false : (t * 0.4 + hash(i)) % 1 < 0.04,
      wave: n > 5 ? 0.5 + 0.5 * Math.sin(step) : 0,
    });
  }
}

function mine(t: number) {
  const vx = W / 2;
  const vy = H * 0.42;
  const boost = recent(LANTERNS, t, 1.2);
  ctx.fillStyle = "#0D0907";
  ctx.fillRect(0, 0, W, H);
  const g = ctx.createRadialGradient(vx, vy, 0, vx, vy, Math.max(W, H) * 0.7);
  g.addColorStop(0, "#050302");
  g.addColorStop(0.12, "#2A1D15");
  g.addColorStop(0.5, "#3A2A1F");
  g.addColorStop(1, "#140D09");
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, W, H);
  // the rails, running away into the dark
  ctx.strokeStyle = "#6A6A72";
  ctx.lineWidth = Math.max(1.5, S * 0.4);
  for (const side of [-1, 1]) {
    ctx.beginPath();
    ctx.moveTo(vx + side * S * 0.5, vy + S * 1);
    ctx.lineTo(vx + side * W * 0.22, H);
    ctx.stroke();
  }
  // timber frames, coming towards us (we're riding the cart), each with a lantern
  const frac = (t * 0.32) % 1;
  for (let k = 0; k < 8; k++) {
    const p = (k + frac) / 8;
    const sc = lerp(0.05, 1.5, p * p);
    const fw = W * 0.42 * sc;
    const fh = H * 0.9 * sc;
    const fog = clamp(p * 1.6, 0, 1);
    const footY = vy + fh * 0.42;
    const beamY = vy - fh * 0.5;
    ctx.save();
    alpha(fog);
    ctx.fillStyle = "#5A3B22";
    const post = Math.max(2, S * 2.4 * sc);
    ctx.fillRect(vx - fw - post / 2, beamY, post, footY - beamY);
    ctx.fillRect(vx + fw - post / 2, beamY, post, footY - beamY);
    ctx.fillRect(vx - fw - post, beamY - post / 2, fw * 2 + post * 2, post);
    ctx.fillStyle = "#3A2A1C";
    ctx.fillRect(vx - W * 0.22 * sc * 1.1, footY, W * 0.44 * sc * 1.1, Math.max(1, post * 0.4));
    ctx.restore();
    const lx = vx + fw * (k % 2 ? 0.55 : -0.55);
    const ly = beamY + post * 2.2;
    const lit = (0.75 + 0.12 * swell(t) + boost * 0.2) * fog;
    ctx.save();
    alpha(fog);
    ctx.strokeStyle = "#2A1D15";
    ctx.lineWidth = Math.max(1, post * 0.15);
    ctx.beginPath();
    ctx.moveTo(lx, beamY);
    ctx.lineTo(lx, ly);
    ctx.stroke();
    rrect(lx - post * 0.6, ly, post * 1.2, post * 1.5, post * 0.3);
    ctx.fillStyle = "#BFE3FF";
    ctx.fill();
    ctx.restore();
    glow(lx, ly + post * 0.7, S * 14 * sc * (1 + boost * 0.5), "rgba(36,150,237,0.9)", lit * 0.8);
    glow(lx, ly + post * 0.7, S * 5 * sc, "rgba(255,240,200,0.9)", lit);
  }
  // dust in the lantern light
  ctx.save();
  for (let i = 0; i < 40; i++) {
    const x = ((hash(i) + t * 0.01 * (hash(i + 1) - 0.5)) % 1) * W;
    const y = ((hash(i + 2) + t * 0.02) % 1) * H * 0.8;
    alpha(0.25 + 0.25 * Math.sin(t + i));
    ell(x, y, S * 0.2, S * 0.2, "#FFE7C2");
  }
  ctx.restore();
  // the container we're riding in, a hamster in it, chewin' soft and slow
  const cw = Math.min(W * 0.36, S * 34);
  const ch = cw * 0.42;
  const cx = W / 2;
  const cy = H * 0.74 + Math.sin(t * 9) * S * 0.25;
  layerProps();
  // (high enough that its seed and paws clear the rim)
  hamster(cx, cy - ch * 0.95, cw * 0.62, {
    t,
    hat: "miner",
    chew: true,
    lamp: 0.8 + swell(t) * 0.1 + boost * 0.2,
  });
  ctx.beginPath();
  ctx.moveTo(cx - cw / 2, cy - ch);
  ctx.lineTo(cx + cw / 2, cy - ch);
  ctx.lineTo(cx + cw * 0.44, cy);
  ctx.lineTo(cx - cw * 0.44, cy);
  ctx.closePath();
  ctx.fillStyle = "#2496ED";
  ctx.fill();
  ctx.strokeStyle = "#1A6FB4";
  ctx.lineWidth = S * 0.5;
  ctx.stroke();
  for (let i = 1; i < 6; i++) {
    const k = i / 6;
    ctx.beginPath();
    ctx.moveTo(cx - cw / 2 + cw * k, cy - ch * 0.92);
    ctx.lineTo(cx - cw * 0.44 + cw * 0.88 * k, cy - ch * 0.08);
    ctx.stroke();
  }
  ell(cx - cw * 0.3, cy + S * 0.4, S * 1.8, S * 1.8, "#3A3A42");
  ell(cx + cw * 0.3, cy + S * 0.4, S * 1.8, S * 1.8, "#3A3A42");
}

function vault(t: number) {
  const b = beatAt(t);
  sky("#081626", "#0E2C48", "#16405E", H);
  // shelves of memories, one lighting up on each beat
  const rows = [0.2, 0.36, 0.52];
  const jw = S * 4.4;
  const n = Math.max(6, Math.floor((W * 0.9) / (jw * 1.7)));
  const gap = (W * 0.9) / n;
  const cols = ["#7FE3FF", "#B9A4FF", "#FFD27A", "#8FE3BE"];
  const centres: { x: number; y: number }[] = [];
  rows.forEach((r, ri) => {
    const y = H * r;
    ctx.fillStyle = "#5A3B22";
    ctx.fillRect(W * 0.04, y, W * 0.92, S * 0.9);
    for (let i = 0; i < n; i++) {
      const x = W * 0.05 + gap * (i + 0.5);
      const idx = ri * n + i;
      const lit = idx % 9 === swellIndex(t) % 9 ? swell(t) : 0;
      const col = cols[Math.floor(hash(idx) * cols.length)];
      const h = jw * (1.2 + hash(idx + 7) * 0.4);
      glow(x, y - h / 2, jw * (1.2 + lit * 0.6), col, 0.25 + lit * 0.25);
      rrect(x - jw / 2, y - h, jw, h, jw * 0.2);
      ctx.fillStyle = "rgba(255,255,255,0.08)";
      ctx.fill();
      ctx.strokeStyle = "rgba(255,255,255,0.35)";
      ctx.lineWidth = Math.max(1, S * 0.2);
      ctx.stroke();
      ctx.fillStyle = "#8A6A4A";
      ctx.fillRect(x - jw * 0.4, y - h - S * 0.6, jw * 0.8, S * 0.6);
      ell(x, y - h * 0.45, jw * 0.22, jw * 0.22, col);
      centres.push({ x, y: y - h * 0.45 });
    }
  });
  // pgvector: memories near in meaning, joined up
  const k = clamp((t - PGVECTOR) / 2.5, 0, 1);
  if (k > 0) {
    ctx.save();
    ctx.strokeStyle = "rgba(160,230,255,0.7)";
    ctx.lineWidth = Math.max(1, S * 0.2);
    ctx.setLineDash([S * 0.8, S * 0.6]);
    const picks = Array.from(
      { length: 9 },
      (_, i) => centres[Math.floor(hash(i + 40) * centres.length)],
    );
    ctx.beginPath();
    picks.forEach((p, i) => {
      if (i / picks.length > k) return;
      if (i) ctx.lineTo(p.x, p.y);
      else ctx.moveTo(p.x, p.y);
    });
    ctx.stroke();
    ctx.restore();
  }
  layerProps();
  // the floor, and Cousin Jack, a candle on his head
  ctx.fillStyle = "#0B1E30";
  ctx.fillRect(0, H * 0.68, W, H);
  const sway = calm ? 0 : Math.sin((b.i + b.phase) * Math.PI) * 0.08;
  const jackSings = lines.some((l) => l.sec === "verse2" && t >= l.s - 0.3 && t <= l.e + 0.3);
  hamster(W * 0.5, H * 0.66, Math.min(S * 18, W * 0.3), {
    t,
    hat: "candle",
    tilt: sway,
    mouth: jackSings ? env(t, 3) * 0.8 : 0,
    seed: true,
    chew: !jackSings,
  });
}

function tunnelPath(which: number, u: number) {
  return which === 0
    ? { x: -0.06 * W + u * 1.12 * W, y: H * (0.3 + 0.07 * Math.sin(u * TAU * 1.3 + 0.5)) }
    : { x: 1.06 * W - u * 1.12 * W, y: H * (0.52 + 0.06 * Math.sin(u * TAU * 1.1 + 2)) };
}

function tunnels(t: number) {
  sky("#3B2616", "#2E1E12", "#22160D", H);
  // the world up top
  ctx.fillStyle = "#8FC4E8";
  ctx.fillRect(0, 0, W, H * 0.09);
  ctx.fillStyle = "#6E9A4C";
  ctx.fillRect(0, H * 0.09, W, S * 1.4);
  // stones
  for (let i = 0; i < 26; i++) {
    ell(
      hash(i + 60) * W,
      H * (0.14 + hash(i + 61) * 0.56),
      S * (0.6 + hash(i) * 1.4),
      S * (0.4 + hash(i) * 0.8),
      "#4A3220",
    );
  }
  // the tunnels
  for (const which of [0, 1]) {
    for (const [lw, col] of [
      [S * 8, "#1E130A"],
      [S * 6.4, "#6B4A2E"],
    ] as const) {
      ctx.strokeStyle = col;
      ctx.lineWidth = lw;
      ctx.lineCap = "round";
      ctx.beginPath();
      for (let i = 0; i <= 60; i++) {
        const p = tunnelPath(which, i / 60);
        if (i) ctx.lineTo(p.x, p.y);
        else ctx.moveTo(p.x, p.y);
      }
      ctx.stroke();
    }
  }
  // cloudflared breezes, blowing through
  for (let j = 0; j < 3; j++) {
    const p = tunnelPath(1, (t * 0.09 + j / 3) % 1);
    ctx.save();
    alpha(0.85);
    for (const [cx, cy, r] of [
      [-1, 0.2, 1],
      [0, -0.3, 1.3],
      [1.1, 0.1, 1],
    ]) {
      ell(p.x + cx * S * 1.4, p.y - S * 0.6 + cy * S * 1.4, r * S * 1.4, r * S * 1.2, "#F6A04D");
    }
    ctx.restore();
  }
  layerProps();
  // the nibblet and its litter, scurrying
  const babies = t < LITTER ? 0 : Math.min(9, Math.floor((t - LITTER) * 3.2));
  for (let i = 0; i <= babies; i++) {
    const which = i % 2;
    const speed = i === 0 ? 0.05 : 0.07 + hash(i) * 0.05;
    const u = (t * speed + hash(i + 9)) % 1;
    const p = tunnelPath(which, u);
    const hop = calm ? 0 : Math.abs(Math.sin(t * 11 + i)) * S * 0.8;
    const size = i === 0 ? S * 9 : S * 5.2;
    hamster(p.x, p.y + S * 2.6 - hop, size, {
      t,
      fur: FURS[i % FURS.length],
      tilt: Math.sin(t * 11 + i) * 0.1,
    });
  }
}

function moor(t: number) {
  const b = beatAt(t);
  sky("#070A1F", "#151B45", "#2B2A66", H * 0.62);
  stars(110, 7, t, H * 0.6);
  const mx = W * 0.8;
  const my = H * 0.18;
  glow(mx, my, S * 24, "rgba(220,225,255,0.5)", 0.5 + swell(t) * 0.1);
  ell(mx, my, S * 6, S * 6, "#F4F1E4");
  // the moor, and old engine houses on it
  ctx.fillStyle = "#1C2148";
  ctx.beginPath();
  ctx.moveTo(0, H);
  ctx.lineTo(0, H * 0.56);
  ctx.quadraticCurveTo(W * 0.3, H * 0.48, W * 0.55, H * 0.55);
  ctx.quadraticCurveTo(W * 0.8, H * 0.6, W, H * 0.52);
  ctx.lineTo(W, H);
  ctx.fill();
  engineHouse(W * 0.32, H * 0.515, S * 0.45, "#141834", "#0A0C1E");
  engineHouse(W * 0.86, H * 0.545, S * 0.32, "#141834", "#0A0C1E");
  ctx.fillStyle = "#11142E";
  ctx.beginPath();
  ctx.moveTo(0, H);
  ctx.lineTo(0, H * 0.72);
  ctx.quadraticCurveTo(W * 0.5, H * 0.62, W, H * 0.7);
  ctx.lineTo(W, H);
  ctx.fill();
  // the tokens, in a chest; the fox, guarding them tight
  const ground = H * 0.68;
  const cx = W * 0.6;
  const cw = Math.min(S * 12, W * 0.16);
  rrect(cx - cw / 2, ground - cw * 0.6, cw, cw * 0.6, S * 0.6);
  ctx.fillStyle = "#7A4A24";
  ctx.fill();
  ctx.fillStyle = "#F2C230";
  ctx.fillRect(cx - cw / 2, ground - cw * 0.42, cw, S * 0.6);
  ell(cx, ground - cw * 0.62, cw * 0.46, cw * 0.14, "#F2C230");
  for (let i = 0; i < 4; i++) {
    const tw = Math.max(0, Math.sin(t * 3 + i * 1.7));
    sparkle(
      cx + (hash(i) - 0.5) * cw * 0.8,
      ground - cw * 0.7 - hash(i + 1) * S * 2,
      S * 1.2 * tw,
      "#FFF4C0",
    );
  }
  layerProps();
  const leap = clamp(1 - Math.abs(t - FOX - 0.3) / 0.6, 0, 1);
  fox(
    W * 0.78,
    ground + S * 1 - Math.sin(leap * Math.PI) * S * 3,
    Math.min(S * 22, W * 0.28),
    t,
    b.kick,
  );
  // a hamster behind a rock, peeking; on "1Password" it pops up, holding the key
  const hold = clamp((t - KEY) / 0.3, 0, 1) * clamp((KEY + 3.8 - t) / 0.4, 0, 1);
  const peek = Math.max(0.5 + 0.5 * Math.sin(t * 0.9), hold);
  const rx = W * 0.24;
  const hs = Math.min(S * 16, W * 0.22);
  const proud = calm ? 0 : hold * Math.abs(Math.sin((b.i + b.phase) * Math.PI)) * S * 0.8;
  const hy = ground + S * 1 - peek * hs * 0.4 - proud;
  // (its arm up beside its head, the key held aloft in that paw, glinting)
  const lift = back(clamp((t - KEY) / 0.35, 0, 1));
  const shoulder = { x: rx + hs * 0.26, y: hy - hs * 0.32 };
  const hand = { x: rx + hs * (0.3 + 0.22 * lift), y: hy - hs * (0.36 + 0.3 * lift) };
  if (hold > 0) {
    ctx.save();
    alpha(hold);
    ctx.lineCap = "round";
    ctx.strokeStyle = FURS[0].deep;
    ctx.lineWidth = hs * 0.13;
    ctx.beginPath();
    ctx.moveTo(shoulder.x, shoulder.y);
    ctx.lineTo(hand.x, hand.y);
    ctx.stroke();
    ctx.strokeStyle = FURS[0].fur;
    ctx.lineWidth = hs * 0.1;
    ctx.stroke();
    ctx.restore();
  }
  hamster(rx, hy, hs, {
    t,
    blink: !hold && (t * 0.35) % 1 < 0.05,
    mouth: hold * 0.5,
    chew: hold === 0,
  });
  ell(rx, ground + S * 2, hs * 0.75, hs * 0.38, "#4A4A5E");
  ell(rx - hs * 0.2, ground - hs * 0.08, hs * 0.25, hs * 0.08, "rgba(255,255,255,0.12)");
  if (hold > 0) {
    const u = (hs / 16) * lift;
    ctx.save();
    alpha(hold);
    key(hand.x, hand.y, u, -Math.PI / 2 + 0.35 + Math.sin(t * 3) * 0.06);
    ell(hand.x, hand.y + u * 0.6, hs * 0.055, hs * 0.045, "#F4AFB4", "#E58B95", 1);
    const glint = u * 1.6 * Math.max(0, Math.sin(t * 5));
    sparkle(hand.x + u * 4, hand.y - u * 6.5, glint, "#FFF4C0");
    ctx.restore();
  }
}

function pub(t: number) {
  const b = beatAt(t);
  sky("#5A3320", "#4A2A1A", "#3A2015", H);
  ctx.strokeStyle = "rgba(0,0,0,0.18)";
  ctx.lineWidth = Math.max(1, S * 0.2);
  for (let x = 0; x < W; x += S * 5) {
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.lineTo(x, H);
    ctx.stroke();
  }
  // the window: night, the sea, the moon
  const wx = W * 0.07;
  const wy = H * 0.16;
  // (on a narrow screen the terminal takes more of the wall)
  const narrow = W < 700;
  const ww = narrow ? W * 0.22 : Math.min(W * 0.24, S * 26);
  const wh = H * 0.26;
  const wg = ctx.createLinearGradient(0, wy, 0, wy + wh);
  wg.addColorStop(0, "#151B45");
  wg.addColorStop(0.65, "#2B2A66");
  wg.addColorStop(0.66, "#1D2C55");
  wg.addColorStop(1, "#132042");
  ctx.fillStyle = wg;
  ctx.fillRect(wx, wy, ww, wh);
  ell(wx + ww * 0.7, wy + wh * 0.3, S * 2.2, S * 2.2, "#F4F1E4");
  ctx.strokeStyle = "#2A170C";
  ctx.lineWidth = S * 1;
  ctx.strokeRect(wx, wy, ww, wh);
  ctx.beginPath();
  ctx.moveTo(wx + ww / 2, wy);
  ctx.lineTo(wx + ww / 2, wy + wh);
  ctx.moveTo(wx, wy + wh / 2);
  ctx.lineTo(wx + ww, wy + wh / 2);
  ctx.stroke();
  // the lamps (before the terminal, so their light doesn't wash it out)
  for (let i = 0; i < 3; i++) {
    const x = W * (0.25 + i * 0.25);
    glow(x, H * 0.1, S * 18, "rgba(255,190,110,0.8)", 0.5 + swell(t) * 0.06);
    ell(x, H * 0.1, S * 1.4, S * 1.4, "#FFE7B0");
  }
  // a terminal on the wall, typing along
  const tw = narrow ? W * 0.62 : Math.min(W * 0.4, S * 46);
  const th = H * 0.28;
  const tx = W * 0.93 - tw;
  const ty = H * 0.14;
  rrect(tx, ty, tw, th, S * 1.2);
  ctx.fillStyle = "#1A1520";
  ctx.fill();
  ctx.strokeStyle = "#2A170C";
  ctx.lineWidth = S * 0.6;
  ctx.stroke();
  ["#FF6F61", "#F2C230", "#6CC56C"].forEach((c, i) =>
    ell(tx + S * (1.6 + i * 1.5), ty + S * 1.5, S * 0.5, S * 0.5, c),
  );
  // the command, typed as it's sung (over two lines when one would be too small to read)
  const whole = `$ ${INSTALL}`;
  const fit = (n: number) => Math.min(S * 1.8, (tw - S * 3) / (n * 0.62));
  const [cmd, url, pipe] = [
    whole.slice(0, whole.indexOf(" https")),
    whole.slice(whole.indexOf("https"), whole.lastIndexOf(" | ")),
    "| bash",
  ];
  // (wrapped as a shell would have it, each broken line ending in a backslash)
  const layouts = [
    [whole],
    [`${cmd} ${url} \\`, `  ${pipe}`],
    [`${cmd} \\`, `  ${url} \\`, `  ${pipe}`],
  ];
  const widest = (rows: string[]) => Math.max(...rows.map((r) => r.length), 26);
  const rows = layouts.find((l) => fit(widest(l)) >= Math.max(S * 1.1, 11)) ?? layouts[2];
  const fs = fit(widest(rows));
  const typed = Math.floor(
    clamp((t - CURL) / Math.max(0.5, BASH - CURL), 0, 1) * rows.join("").length,
  );
  ctx.font = `600 ${fs}px ${MONO}`;
  ctx.textAlign = "left";
  ctx.textBaseline = "top";
  ctx.fillStyle = "#FFE7C2";
  const lx = tx + S * 1.5;
  let ly = ty + S * 3.6 - fs * 1.6;
  let left = Math.max(typed, 1);
  let cursor = { x: lx, y: ly };
  for (const row of rows) {
    if (left <= 0) break;
    ly += fs * 1.6;
    const shown = row.slice(0, left);
    left -= row.length;
    ctx.fillText(shown, lx, ly);
    cursor = { x: lx + ctx.measureText(shown).width, y: ly };
  }
  const out: [number, string, string][] = [
    [BASH + 0.2, "Installing nibblets… 🐹", "#B9B0AA"],
    [SIGN, "✓ signed in (again)", "#8FE3BE"],
    [DONE, "✓ done before the flash!", "#8FE3BE"],
  ];
  for (const [at, line, c] of out) {
    if (t < at) continue;
    ly += fs * 1.6;
    ctx.fillStyle = c;
    ctx.fillText(line, lx, ly);
    cursor = { x: lx, y: ly + fs * 1.6 };
  }
  if (Math.floor(t * 2.5) % 2 === 0) {
    ctx.fillStyle = "#FFE7C2";
    ctx.fillRect(cursor.x, cursor.y, fs * 0.55, fs);
  }
  // beams and bunting
  ctx.fillStyle = "#2A170C";
  ctx.fillRect(0, 0, W, H * 0.06);
  bunting(H * 0.06, t, b.kick);
  layerProps();
  // the bar, three hamsters at it, cider up
  const ground = H * 0.62;
  const raised = clamp(Math.min((t - RAISE) / 0.6, (HIGH + 1.5 - t) / 0.6), 0, 1);
  const n = 3;
  const gap = Math.min(W * 0.26, S * 26);
  const size = Math.min(S * 17, gap * 0.8);
  for (let i = 0; i < n; i++) {
    const x = W / 2 + (i - 1) * gap;
    const step = (b.i + b.phase + i * 0.33) * Math.PI;
    hamster(x, ground + size * 0.25, size, {
      t,
      fur: FURS[(i + 2) % FURS.length],
      tilt: calm ? 0 : Math.sin(step) * 0.08,
      mouth: env(t, 3) * 0.9,
      blink: raised > 0.5,
    });
  }
  ctx.fillStyle = "#6B3B1F";
  ctx.fillRect(0, ground, W, H - ground);
  ctx.fillStyle = "#8A5230";
  ctx.fillRect(0, ground, W, S * 1.4);
  for (let i = 0; i < n; i++) {
    const x = W / 2 + (i - 1) * gap + size * 0.42;
    const lift = raised * size * 0.45 + (calm ? 0 : b.kick * S * 0.4);
    ctx.save();
    ctx.translate(x - raised * size * 0.1, ground - S * 0.2 - lift);
    ctx.rotate(-raised * 0.35);
    mug(0, 0, size * 0.3);
    ctx.restore();
  }
}

function scene(kind: Kind, t: number) {
  switch (kind) {
    case "intro":
      return cliffs(t, { ...DAWN, dancers: 1, title: t > 0.4 ? "Nibblets of Kernow" : undefined });
    case "verse1":
      return mine(t);
    case "chorus":
      return cliffs(t, { ...GOLDEN, dancers: 5, bunting: true });
    case "verse2":
      return vault(t);
    case "verse3":
      return tunnels(t);
    case "verse4":
      return moor(t);
    case "verse5":
      return pub(t);
    case "final":
      return cliffs(t, { ...NIGHT, dancers: 7, bunting: true, fireworks: 2 });
    case "outro":
      return cliffs(t, { ...NIGHT, dancers: 7, fireworks: 4 });
  }
}

// ---------------------------------------------------------------- flung pasties
// Tap the stage and a pasty flies to where you tapped (on the clock of the room, not the song).

interface Flung {
  at: number;
  x: number;
  y: number;
  from: number;
  shout: string;
}
let flung: Flung[] = [];
let pastiesFlung = 0;
const now = () => performance.now() / 1000;

function drawFlung() {
  const tn = now();
  flung = flung.filter((f) => tn - f.at < 1.9);
  for (const f of flung) {
    const age = tn - f.at;
    const fly = 0.5;
    if (age < fly) {
      const k = age / fly;
      const x = lerp(f.from, f.x, k);
      const y = lerp(H + S * 4, f.y, k) - Math.sin(k * Math.PI) * H * 0.18;
      pasty(x, y, S * 5 * (1.3 - k * 0.4), k * TAU * 1.5);
      continue;
    }
    const k = (age - fly) / 1.4;
    ctx.save();
    alpha(1 - k);
    for (let i = 0; i < 16; i++) {
      const a = hash(f.at + i) * TAU;
      const d = out3(k * 1.5) * S * (4 + hash(i + f.at) * 8);
      const r = S * (0.3 + hash(i * 2) * 0.6);
      ell(
        f.x + Math.cos(a) * d,
        f.y + Math.sin(a) * d + k * k * S * 10,
        r,
        r,
        i % 2 ? "#E9B65A" : "#C88A34",
      );
    }
    ctx.shadowColor = "rgba(0,0,0,0.4)";
    ctx.shadowBlur = S;
    text(f.shout, f.x, f.y - S * 3 - out3(k) * S * 5, S * 3.2 * back(k * 3), "#FFE7C2");
    ctx.restore();
  }
}

// ---------------------------------------------------------------- each frame

// The props go in behind a scene's characters: each scene calls layerProps() just before it
// draws them (only the current scene has any pending).
let pendingProps: (() => void) | undefined;
function layerProps() {
  const draw = pendingProps;
  pendingProps = undefined;
  draw?.();
}

function draw(t: number) {
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.globalAlpha = 1;
  ctx.globalCompositeOperation = "source-over";
  const si = sectionAt(t);
  const sec = sections[si];
  const k = si > 0 ? clamp((t - sec.at) / 0.9, 0, 1) : 1;
  const bass = calm ? 0 : env(t, 0);
  ctx.save();
  ctx.translate(W / 2, H / 2);
  ctx.scale(1 + bass * 0.012, 1 + bass * 0.012);
  ctx.translate(-W / 2, -H / 2);
  if (k < 1) {
    sceneAlpha = 1;
    ctx.globalAlpha = 1;
    scene(sections[si - 1].kind, t);
  }
  sceneAlpha = out3(k);
  ctx.globalAlpha = sceneAlpha;
  pendingProps = () => {
    for (const p of props) prop(p, t);
  };
  scene(sec.kind, t);
  layerProps();
  sceneAlpha = 1;
  ctx.globalAlpha = 1;
  ctx.restore();
  // shade under the words, so they read on any scene
  const g = ctx.createLinearGradient(0, H * 0.55, 0, H);
  g.addColorStop(0, "rgba(10,6,20,0)");
  g.addColorStop(1, "rgba(10,6,20,0.72)");
  ctx.fillStyle = g;
  ctx.fillRect(0, H * 0.55, W, H * 0.45);
  const top = ctx.createLinearGradient(0, 0, 0, S * 14);
  top.addColorStop(0, "rgba(10,6,20,0.45)");
  top.addColorStop(1, "rgba(10,6,20,0)");
  ctx.fillStyle = top;
  ctx.fillRect(0, 0, W, S * 14);
  const flash =
    Math.sin(clamp(1 - recent(FLASH, t, 1.2), 0, 1) * Math.PI) *
    (recent(FLASH, t, 1.2) > 0 ? 1 : 0);
  if (flash > 0 && !calm) {
    ctx.fillStyle = `rgba(255,240,210,${flash * 0.2})`;
    ctx.fillRect(0, 0, W, H);
  }
  drawFlung();
}

let lastCur = -2;
let lastSec = -1;
let lastHint = -1;

function updateWords(t: number) {
  // which line is being sung, and which is up next
  let cur = -1;
  for (const l of lines) if (l.show <= t && t < l.hide) cur = l.i;
  let next = cur >= 0 ? cur + 1 : lines.findIndex((l) => l.show > t && l.show - t < 2.5);
  if (next >= lines.length) next = -1;
  if (cur !== lastCur) {
    lastCur = cur;
    for (const l of lines) {
      const el = l.el;
      if (!el) continue;
      el.classList.toggle("is-cur", l.i === cur);
      el.classList.toggle("is-next", l.i === next);
      el.classList.toggle("is-prev", cur >= 0 && l.i === cur - 1);
    }
    const nextEl = next >= 0 ? lines[next].el : undefined;
    els.lyrics.style.setProperty("--nh", `${nextEl ? nextEl.offsetHeight * 0.5 : 0}px`);
    const curEl = cur >= 0 ? lines[cur].el : undefined;
    if (curEl) els.lyrics.style.setProperty("--h", `${curEl.offsetHeight}px`);
  }
  for (const i of [cur, next]) {
    if (i < 0) continue;
    for (const w of lines[i].words) {
      const p = clamp((t - w.s) / Math.max(0.05, w.e - w.s), 0, 1);
      const rounded = Math.round(p * 50) / 50;
      if (rounded !== w.p && w.el) {
        w.p = rounded;
        w.el.style.setProperty("--p", String(rounded));
      }
      const on = t >= w.s;
      if (on !== w.on && w.el) {
        w.on = on;
        w.el.classList.toggle("is-on", on);
      }
    }
  }
  // the section, and any word of explanation
  const si = sectionAt(t);
  if (si !== lastSec) {
    lastSec = si;
    const kind = sections[si].kind;
    els.sec.textContent = audio.paused && t === 0 ? "" : NAMES[kind];
    els.sec.style.setProperty("--tag", TAGS[kind]);
    els.sec.classList.remove("swap");
    void els.sec.offsetWidth;
    els.sec.classList.add("swap");
  }
  let hi = -1;
  hints.forEach((h, i) => {
    if (t >= h.at && t < h.at + 4.5) hi = i;
  });
  if (hi !== lastHint) {
    lastHint = hi;
    if (hi >= 0) els.hint.innerHTML = hints[hi].html;
    els.hint.classList.toggle("show", hi >= 0);
  }
}

function fmt(s: number) {
  const m = Math.floor(s / 60);
  return `${m}:${String(Math.floor(s % 60)).padStart(2, "0")}`;
}
const duration = () =>
  Number.isFinite(audio.duration) && audio.duration > 0 ? audio.duration : SONG_LENGTH;

function updateBar(t: number) {
  const k = clamp(t / duration(), 0, 1);
  els.fill.style.transform = `scaleX(${k})`;
  els.knob.style.left = `${k * 100}%`;
  els.knob.style.transform = `rotate(${t * 140}deg)`;
  els.time.textContent = `${fmt(t)} / ${fmt(duration())}`;
  els.track.setAttribute("aria-valuenow", String(Math.round(t)));
  els.track.setAttribute("aria-valuetext", `${fmt(t)} of ${fmt(duration())}`);
}

function frame() {
  raf = requestAnimationFrame(frame);
  if (!audio.paused || dirty || flung.length) {
    const t = audio.currentTime;
    draw(t);
    updateWords(t);
    updateBar(t);
    dirty = false;
  }
}

function resize() {
  dpr = Math.min(2, window.devicePixelRatio || 1);
  W = root?.clientWidth ?? window.innerWidth;
  H = root?.clientHeight ?? window.innerHeight;
  S = Math.min(W / 70, H / 62);
  cv.width = Math.round(W * dpr);
  cv.height = Math.round(H * dpr);
  lastCur = -2;
  dirty = true;
}

// ---------------------------------------------------------------- the page around it

const ICON = {
  play: '<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M6 3.5v13l10.5-6.5z" fill="currentColor"/></svg>',
  pause:
    '<svg viewBox="0 0 20 20" aria-hidden="true"><rect x="4.5" y="3.5" width="4" height="13" rx="1.2" fill="currentColor"/><rect x="11.5" y="3.5" width="4" height="13" rx="1.2" fill="currentColor"/></svg>',
  close:
    '<svg viewBox="0 0 18 18" aria-hidden="true"><path d="M4 4l10 10M14 4L4 14" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"/></svg>',
  pasty:
    '<svg viewBox="0 0 26 18" aria-hidden="true"><path d="M2 15 A11 11 0 0 1 24 15 Z" fill="#E9B65A" stroke="#9A5F1E" stroke-width="1.4" stroke-linejoin="round"/><path d="M4 9.5 l2 1 M7.5 5.5 l1.5 1.6 M12 4 v2 M16.5 5.5 l-1.5 1.6 M20 9.5 l-2 1" stroke="#9A5F1E" stroke-width="1.3" stroke-linecap="round"/></svg>',
};

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls: string, html = "") {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (html) e.innerHTML = html;
  return e;
}

function add(parent: HTMLElement, ...kids: HTMLElement[]) {
  for (const kid of kids) parent.appendChild(kid);
}

function build() {
  root = el("div", "sa");
  root.hidden = true;
  root.setAttribute("role", "dialog");
  root.setAttribute("aria-modal", "true");
  root.setAttribute("aria-label", "Nibblets of Kernow: a singalong");

  cv = el("canvas", "sa-cv");
  cv.setAttribute("aria-hidden", "true");
  const c = cv.getContext("2d");
  if (!c) throw new Error("No 2D canvas here");
  ctx = c;

  const top = el("div", "sa-top");
  const x = el("button", "sa-x", ICON.close);
  x.type = "button";
  x.setAttribute("aria-label", "Close the singalong");
  top.appendChild(x);

  els.sec = el("div", "sa-sec");
  els.hint = el("div", "sa-hint");
  els.hint.setAttribute("aria-live", "polite");

  els.lyrics = el("div", "sa-lyrics");
  for (const l of lines) {
    const line = el("div", "sa-l");
    l.words.forEach((w, j) => {
      const span = el("span", `sa-w ${wordClass(w.key)}`);
      span.textContent = w.text;
      w.el = span;
      line.appendChild(span);
      if (j < l.words.length - 1) line.appendChild(document.createTextNode(" "));
    });
    l.el = line;
    els.lyrics.appendChild(line);
  }

  const bar = el("div", "sa-bar");
  els.play = el("button", "sa-play", ICON.play);
  els.play.setAttribute("aria-label", "Play");
  (els.play as HTMLButtonElement).type = "button";
  els.track = el("div", "sa-track");
  els.track.setAttribute("role", "slider");
  els.track.setAttribute("tabindex", "0");
  els.track.setAttribute("aria-label", "Where we are in the song");
  els.track.setAttribute("aria-valuemin", "0");
  els.track.setAttribute("aria-valuemax", String(Math.round(SONG_LENGTH)));
  const rail = el("div", "sa-rail");
  els.fill = el("div", "sa-fill");
  rail.appendChild(els.fill);
  els.track.appendChild(rail);
  for (const s of sections.slice(1)) {
    const tick = el("div", "sa-tick");
    tick.style.left = `${(s.s / SONG_LENGTH) * 100}%`;
    tick.title = NAMES[s.kind];
    els.track.appendChild(tick);
  }
  els.knob = el("div", "sa-knob", ICON.pasty);
  els.track.appendChild(els.knob);
  els.time = el("div", "sa-time", "0:00 / 3:09");
  add(bar, els.play, els.track, els.time);

  els.start = el(
    "div",
    "sa-card",
    `<div>
      <h2>Nibblets of <em>Kernow</em></h2>
      <p>Three minutes about hamsters who chew through your tasks, sung the old way. The words light up as they're sung, so <b>sing along</b>.</p>
      <button type="button" class="sa-go">${ICON.play} Start singing</button>
      <div class="sa-keys"><kbd>Space</kbd> pause · <kbd>←</kbd> <kbd>→</kbd> skip · <kbd>Esc</kbd> leave<br>Tap the stage to fling a pasty</div>
      <div class="sa-err" hidden></div>
    </div>`,
  );
  els.end = el(
    "div",
    "sa-card",
    `<div>
      <h2>Proper <em>job!</em></h2>
      <p class="sa-score">Fancy some nibblets of your own? One line, on any Linux box:</p>
      <div class="sa-cmd"><code>${INSTALL}</code><button type="button" data-copy>Copy</button></div>
      <div class="sa-row">
        <button type="button" class="sa-go" data-again>${ICON.play} Sing it again</button>
        <button type="button" class="sa-ghost" data-leave>Back to the site</button>
      </div>
    </div>`,
  );
  els.end.hidden = true;

  add(root, cv, top, els.sec, els.hint, els.lyrics, bar, els.start, els.end);
  document.body.appendChild(root);

  // ---- wiring
  audio = new Audio(SONG_URL);
  audio.preload = "auto";
  audio.addEventListener("play", () => setPlaying(true));
  audio.addEventListener("pause", () => setPlaying(false));
  audio.addEventListener("ended", showEnd);
  audio.addEventListener("seeked", () => (dirty = true));
  audio.addEventListener("loadedmetadata", () => {
    els.track.setAttribute("aria-valuemax", String(Math.round(duration())));
    dirty = true;
  });

  x.addEventListener("click", close);
  els.play.addEventListener("click", toggle);
  els.start.querySelector(".sa-go")?.addEventListener("click", start);
  els.end.querySelector("[data-again]")?.addEventListener("click", () => {
    els.end.hidden = true;
    audio.currentTime = 0;
    start();
  });
  els.end.querySelector("[data-leave]")?.addEventListener("click", close);
  const copy = els.end.querySelector<HTMLButtonElement>("[data-copy]");
  copy?.addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(INSTALL);
      copy.textContent = "Copied!";
    } catch {
      copy.textContent = "Select it";
    }
    setTimeout(() => (copy.textContent = "Copy"), 1800);
  });

  let dragging = false;
  const seekTo = (e: PointerEvent) => {
    const r = els.track.getBoundingClientRect();
    audio.currentTime = clamp((e.clientX - r.left) / r.width, 0, 1) * duration();
    dirty = true;
  };
  els.track.addEventListener("pointerdown", (e) => {
    dragging = true;
    els.track.setPointerCapture(e.pointerId);
    seekTo(e);
  });
  els.track.addEventListener("pointermove", (e) => dragging && seekTo(e));
  els.track.addEventListener("pointerup", () => (dragging = false));
  els.track.addEventListener("pointercancel", () => (dragging = false));

  cv.addEventListener("pointerdown", (e) => {
    const r = cv.getBoundingClientRect();
    const px = e.clientX - r.left;
    flung.push({
      at: now(),
      x: px,
      y: e.clientY - r.top,
      from: clamp(px + (hash(pastiesFlung) - 0.5) * W * 0.5, 0, W),
      shout: SHOUTS[Math.floor(hash(pastiesFlung + 0.7) * SHOUTS.length)],
    });
    pastiesFlung++;
  });

  window.addEventListener("resize", () => root && !root.hidden && resize());
  document.addEventListener("keydown", onKey);
}

function onKey(e: KeyboardEvent) {
  if (!root || root.hidden) return;
  const onButton = e.target instanceof HTMLButtonElement;
  if (e.key === "Escape") {
    e.preventDefault();
    close();
  } else if ((e.key === " " || e.key === "k") && !onButton) {
    e.preventDefault();
    if (!els.start.hidden) start();
    else toggle();
  } else if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
    e.preventDefault();
    audio.currentTime = clamp(audio.currentTime + (e.key === "ArrowLeft" ? -5 : 5), 0, duration());
    dirty = true;
  } else if (e.key === "Tab") {
    // keep focus inside the singalong
    const focusable = [...root.querySelectorAll<HTMLElement>("button, [tabindex='0']")].filter(
      (f) => f.offsetParent !== null,
    );
    if (!focusable.length) return;
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (e.shiftKey && document.activeElement === first) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault();
      first.focus();
    }
  }
}

function setPlaying(playing: boolean) {
  els.play.innerHTML = playing ? ICON.pause : ICON.play;
  els.play.setAttribute("aria-label", playing ? "Pause" : "Play");
  lastSec = -1;
  dirty = true;
}

function toggle() {
  if (audio.paused) void play();
  else audio.pause();
}

async function play() {
  const err = els.start.querySelector<HTMLElement>(".sa-err");
  try {
    await audio.play();
    if (err) err.hidden = true;
    return true;
  } catch {
    if (err) {
      err.hidden = false;
      err.textContent = "The fiddler's gone missing: the song wouldn't play. Try again?";
    }
    return false;
  }
}

async function start() {
  if (!(await play())) return;
  els.start.classList.add("away");
  setTimeout(() => {
    els.start.hidden = true;
    els.start.classList.remove("away");
  }, 450);
  els.play.focus();
}

function showEnd() {
  const score = els.end.querySelector(".sa-score");
  if (score) {
    const n = pastiesFlung;
    score.textContent =
      (n ? `You flung ${n} ${n === 1 ? "pasty" : "pasties"}. ` : "") +
      "Fancy some nibblets of your own? One line, on any Linux box:";
  }
  els.end.hidden = false;
  els.end.querySelector<HTMLButtonElement>("[data-again]")?.focus();
}

/** Open the singalong (building it the first time). */
export function open() {
  if (!root) build();
  if (!root || !root.hidden) return;
  returnFocus = document.activeElement;
  root.hidden = false;
  document.documentElement.style.overflow = "hidden";
  resize();
  if (audio.paused && (audio.currentTime === 0 || audio.ended)) {
    audio.currentTime = 0;
    els.end.hidden = true;
    els.start.hidden = false;
  }
  if (location.hash !== "#singalong") history.replaceState(null, "", "#singalong");
  cancelAnimationFrame(raf);
  raf = requestAnimationFrame(frame);
  const focus = els.start.hidden ? els.play : els.start.querySelector<HTMLElement>(".sa-go");
  focus?.focus();
}

export function close() {
  if (!root || root.hidden) return;
  audio.pause();
  root.hidden = true;
  document.documentElement.style.overflow = "";
  cancelAnimationFrame(raf);
  if (location.hash === "#singalong")
    history.replaceState(null, "", location.pathname + location.search);
  if (returnFocus instanceof HTMLElement) returnFocus.focus();
}

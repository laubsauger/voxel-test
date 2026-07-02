#!/usr/bin/env node
/**
 * T36/T38 [A] — SFX + music asset pipeline (I.audio).
 *
 * Generates the game's sound set via the ElevenLabs API and writes
 * public/audio/manifest.json. Node 24+, ESM, zero deps (global fetch).
 *
 * Usage:
 *   node scripts/audio/generate-sfx.mjs             # generate all missing sfx + music
 *   node scripts/audio/generate-sfx.mjs --only=sfx  # sfx only
 *   node scripts/audio/generate-sfx.mjs --only=music
 *   node scripts/audio/generate-sfx.mjs --dry       # list plan, no API calls
 *   node scripts/audio/generate-sfx.mjs --limit=1   # generate at most N missing files
 *
 * SECURITY: the API key lives in .env.dev at the repo root (gitignored).
 * It is read at runtime, sent ONLY to api.elevenlabs.io, and never logged —
 * every console line passes through redact(). Never import this file from
 * client code (src/**); the client only consumes the pre-generated assets.
 *
 * COST: each generation costs credits. The script is idempotent — files that
 * already exist on disk are skipped. To regenerate one sound, delete its file
 * and re-run. Do NOT delete public/audio wholesale.
 */
import { mkdir, readFile, writeFile, access } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(SCRIPT_DIR, '../..')
const AUDIO_DIR = path.join(ROOT, 'public/audio')
const MANIFEST_PATH = path.join(AUDIO_DIR, 'manifest.json')

const API_BASE = 'https://api.elevenlabs.io'
const SFX_ENDPOINT = `${API_BASE}/v1/sound-generation?output_format=mp3_44100_128`
const MUSIC_ENDPOINT = `${API_BASE}/v1/music?output_format=mp3_44100_128`

// ---------------------------------------------------------------------------
// key handling — never leaves this scope except as a request header
// ---------------------------------------------------------------------------
let apiKey = null

function redact(s) {
  let out = String(s)
  if (apiKey) out = out.split(apiKey).join('<redacted>')
  // belt & suspenders: mask anything that looks like an EL key
  out = out.replace(/sk_[a-zA-Z0-9]{16,}/g, '<redacted>')
  return out
}
const log = (...a) => console.log(...a.map(redact))
const warn = (...a) => console.warn(...a.map(redact))

async function loadKey() {
  const envPath = path.join(ROOT, '.env.dev')
  let text
  try {
    text = await readFile(envPath, 'utf8')
  } catch {
    throw new Error(`missing ${envPath} — create it with ELEVENLABS_API_KEY=... (never commit it)`)
  }
  const m = text.match(/^ELEVENLABS_API_KEY=(.+)$/m)
  if (!m || !m[1].trim()) throw new Error('ELEVENLABS_API_KEY not found in .env.dev')
  apiKey = m[1].trim()
}

// ---------------------------------------------------------------------------
// sound spec — the single authority for what exists and how it's prompted.
// Prompt style: material + action + acoustic space, suburban outdoor context,
// close-mic AAA foley, explicit "no music / clean tail" guards against slop.
// ---------------------------------------------------------------------------
/** shared prompt tails */
const FOLEY = 'professional AAA game foley, close-mic, clean recording, no music, no voices'
const OUTDOOR = 'quiet suburban outdoor acoustic space, minimal reverb'

/**
 * group: {
 *   category, dir, count, duration (s), promptFor(n), loop, volume, positional,
 *   promptInfluence?
 * }
 */
function footstepGroup(gait, surface, prompt, variants) {
  return {
    group: `footstep-${gait}-${surface}`,
    category: 'footsteps',
    dir: 'footsteps',
    count: variants.length,
    duration: 0.6,
    loop: false,
    volume: 0.7,
    positional: true,
    promptFor: (n) => `Single ${gait === 'run' ? 'fast heavy running' : 'casual walking'} footstep, ${prompt}, ${variants[n - 1]}, one step only, ${OUTDOOR}, ${FOLEY}`,
  }
}

const STEP_VARIANTS = ['heel-first contact', 'flat even contact', 'slight toe scuff at the end']

const FOOTSTEP_SURFACES = [
  ['grass', 'sneaker on dry suburban lawn grass, soft turf compression with subtle blade rustle'],
  ['concrete', 'sneaker on a smooth concrete sidewalk, hard slap with tiny grit'],
  ['asphalt', 'sneaker on rough asphalt street, gritty granular contact'],
  ['wood', 'sneaker on a wooden porch deck plank, low hollow knock'],
  ['dirt', 'sneaker on packed dry dirt with small pebbles, dull earthy thud'],
  ['water', 'sneaker stepping in ankle-deep water, small sloshing splash'],
]

const SFX_GROUPS = [
  // --- footsteps: walk + run × 6 surfaces × 3 variants ---------------------
  ...FOOTSTEP_SURFACES.flatMap(([surface, prompt]) => [
    footstepGroup('walk', surface, prompt, STEP_VARIANTS),
    footstepGroup('run', surface, prompt, STEP_VARIANTS),
  ]),

  // --- jump: takeoff scuff + landing, hard/soft ------------------------------
  {
    group: 'jump-takeoff-hard',
    category: 'jump', dir: 'jump', count: 2, duration: 0.6, loop: false, volume: 0.65, positional: true,
    promptFor: (n) => `Sneaker sole scuffing off concrete as a person jumps, quick push-off scrape, no voice, ${n === 2 ? 'slightly sharper scrape' : 'soft short scrape'}, ${OUTDOOR}, ${FOLEY}`,
  },
  {
    group: 'jump-takeoff-soft',
    category: 'jump', dir: 'jump', count: 2, duration: 0.6, loop: false, volume: 0.6, positional: true,
    promptFor: (n) => `Sneaker pushing off grass and soil as a person jumps, soft turf scuff, no voice, ${n === 2 ? 'a touch more soil crunch' : 'mostly grass rustle'}, ${OUTDOOR}, ${FOLEY}`,
  },
  {
    group: 'jump-land-hard',
    category: 'jump', dir: 'jump', count: 2, duration: 0.8, loop: false, volume: 0.8, positional: true,
    promptFor: (n) => `Two-footed landing on concrete from a small jump, weighty double thump of sneakers, clothing rustle, no voice, ${n === 2 ? 'slightly staggered feet' : 'feet together'}, ${OUTDOOR}, ${FOLEY}`,
  },
  {
    group: 'jump-land-soft',
    category: 'jump', dir: 'jump', count: 2, duration: 0.8, loop: false, volume: 0.75, positional: true,
    promptFor: (n) => `Two-footed landing on a lawn from a small jump, muffled earthy double thud with grass rustle, no voice, ${n === 2 ? 'slightly heavier' : 'light and quick'}, ${OUTDOOR}, ${FOLEY}`,
  },

  // --- shooting --------------------------------------------------------------
  {
    group: 'shot-pistol',
    category: 'shoot', dir: 'shoot', count: 2, duration: 1.2, loop: false, volume: 0.9, positional: false,
    promptFor: (n) => `Single 9mm pistol gunshot fired outdoors in a suburban street, punchy dry crack with tight mechanical snap, short natural decay${n === 2 ? ', marginally deeper report' : ''}, no ricochet, no music, professional AAA game weapon sound design`,
  },
  {
    group: 'shot-echo-tail',
    category: 'shoot', dir: 'shoot', count: 1, duration: 2.5, loop: false, volume: 0.5, positional: false,
    promptFor: () => 'Distant gunshot echo tail rolling across a suburban neighborhood, soft diffuse reflections off houses fading out, no initial crack, no music, professional AAA game sound design',
  },

  // --- impacts × material ----------------------------------------------------
  ...[
    ['dirt', 'a bullet smacking into packed dirt, dull earthy thump with a small spray of soil debris', 0.8],
    ['grass', 'a bullet hitting turf and soil under grass, muffled soft thud with grass flutter', 0.8],
    ['concrete', 'a bullet striking a concrete wall, sharp cracking chip with stone fragments scattering', 0.9],
    ['brick', 'a bullet hitting a brick wall, hard ceramic crack with crumbling mortar dust', 0.9],
    ['wood', 'a bullet punching into a wooden plank wall, sharp splintering knock', 0.9],
    ['glass', 'a bullet shattering a window pane, bright glass crack with shards tinkling onto pavement', 1.0],
    ['metal', 'a bullet hitting sheet metal, sharp metallic clank with short ring', 0.9],
    ['water', 'a bullet plunking into a swimming pool, quick compact water plip with tiny droplets', 0.8],
  ].map(([mat, prompt, vol]) => ({
    group: `impact-${mat}`,
    category: 'impact', dir: 'impacts', count: 2, duration: 1.0, loop: false, volume: vol, positional: true,
    promptFor: (n) => `Close impact of ${prompt}${n === 2 ? ', slightly different angle and debris' : ''}, single hit, ${OUTDOOR}, ${FOLEY}`,
  })),

  // --- explosions --------------------------------------------------------------
  {
    group: 'explosion-small',
    category: 'explosion', dir: 'explosions', count: 1, duration: 2.0, loop: false, volume: 0.9, positional: true,
    promptFor: () => 'Small grenade-sized explosion in a suburban yard, tight punchy blast with dirt and light debris scatter, short low tail, no music, cinematic AAA game explosion sound design',
  },
  {
    group: 'explosion-medium',
    category: 'explosion', dir: 'explosions', count: 1, duration: 3.0, loop: false, volume: 1.0, positional: true,
    promptFor: () => 'Medium explosion destroying part of a house, deep concussive blast with cracking masonry and wood, debris thrown outward, rolling low-end tail, no music, cinematic AAA game explosion sound design',
  },
  {
    group: 'explosion-large',
    category: 'explosion', dir: 'explosions', count: 1, duration: 4.5, loop: false, volume: 1.0, positional: true,
    promptFor: () => 'Huge devastating explosion leveling a suburban house, massive sub-heavy detonation, shockwave crack, collapsing structure, long rumbling decay with settling debris, no music, cinematic AAA game explosion sound design',
  },
  {
    group: 'explosion-debris-rain',
    category: 'explosion', dir: 'explosions', count: 1, duration: 3.5, loop: false, volume: 0.7, positional: true,
    promptFor: () => 'Aftermath of an explosion: debris raining down, chunks of concrete, wood splinters and gravel pattering onto pavement and grass, gradually thinning out, no blast, no music, AAA game sound design',
  },
  {
    group: 'explosion-distant-rumble',
    category: 'explosion', dir: 'explosions', count: 1, duration: 3.5, loop: false, volume: 0.6, positional: false,
    promptFor: () => 'Very distant explosion heard across a neighborhood, soft deep muffled boom rolling like thunder, long faded low rumble, no close detail, no music, AAA game sound design',
  },

  // --- destruction --------------------------------------------------------------
  {
    group: 'collapse-structure',
    category: 'destruction', dir: 'destruction', count: 2, duration: 3.5, loop: false, volume: 0.9, positional: true,
    promptFor: (n) => `A two-story house section collapsing: cracking wooden beams splintering, masonry and bricks crashing down in a cascade, dust settling at the end${n === 2 ? ', heavier masonry emphasis' : ', heavier wood splinter emphasis'}, no music, cinematic AAA game destruction sound design`,
  },
  {
    group: 'glass-pane-shatter',
    category: 'destruction', dir: 'destruction', count: 2, duration: 1.5, loop: false, volume: 0.85, positional: true,
    promptFor: (n) => `A large window pane shattering completely, bright glass break with shards cascading and tinkling onto a hard floor${n === 2 ? ', slightly smaller pane' : ''}, ${OUTDOOR}, ${FOLEY}`,
  },
  {
    group: 'chunk-crumble',
    category: 'destruction', dir: 'destruction', count: 2, duration: 1.5, loop: false, volume: 0.7, positional: true,
    promptFor: (n) => `A chunk of masonry crumbling and breaking apart, rocks and rubble tumbling briefly then settling${n === 2 ? ', drier smaller pieces' : ''}, ${OUTDOOR}, ${FOLEY}`,
  },

  // --- vehicles (T64) --------------------------------------------------------
  {
    group: 'engine-idle-loop',
    category: 'vehicle', dir: 'vehicle', count: 1, duration: 8, loop: true, volume: 0.55, positional: true,
    promptFor: () => 'Compact sedan car engine idling steadily, warm smooth four-cylinder combustion purr at low RPM, constant speed, seamless loop, exterior perspective, no music, no voices, AAA game vehicle sound design',
  },
  {
    group: 'engine-rev-loop',
    category: 'vehicle', dir: 'vehicle', count: 1, duration: 8, loop: true, volume: 0.7, positional: true,
    promptFor: () => 'Compact sedan car engine running steadily at mid-high RPM while driving, smooth constant four-cylinder tone with light exhaust rasp, constant speed, no gear changes, seamless loop, exterior perspective, no music, no voices, AAA game vehicle sound design',
  },
  {
    group: 'skid-loop',
    category: 'vehicle', dir: 'vehicle', count: 1, duration: 4, loop: true, volume: 0.8, positional: true,
    promptFor: () => 'Car tires skidding and screeching on asphalt during a hard drift, sustained rubber squeal at constant intensity, seamless loop, no engine, no music, no voices, AAA game vehicle sound design',
  },
  {
    group: 'car-crash-small',
    category: 'vehicle', dir: 'vehicle', count: 2, duration: 1.5, loop: false, volume: 0.85, positional: true,
    promptFor: (n) => `Car bumping into an obstacle at low speed, dull sheet metal thump with a small rattle of parts${n === 2 ? ', slightly harder hit with a hubcap wobble' : ''}, single impact, ${OUTDOOR}, ${FOLEY}`,
  },
  {
    group: 'car-crash-large',
    category: 'vehicle', dir: 'vehicle', count: 1, duration: 2.5, loop: false, volume: 1.0, positional: true,
    promptFor: () => 'Violent car crash into a brick wall: heavy metal crunch, buckling body panels, glass shattering, debris clattering onto pavement, short settling tail, single impact, no music, no voices, cinematic AAA game vehicle crash sound design',
  },
  {
    group: 'car-door-open',
    category: 'vehicle', dir: 'vehicle', count: 1, duration: 0.8, loop: false, volume: 0.6, positional: true,
    promptFor: () => `Car door handle click and door swinging open with a soft hinge creak, ${OUTDOOR}, ${FOLEY}`,
  },
  {
    group: 'car-door-close',
    category: 'vehicle', dir: 'vehicle', count: 1, duration: 0.8, loop: false, volume: 0.65, positional: true,
    promptFor: () => `Car door slamming shut with a solid reassuring thunk, ${OUTDOOR}, ${FOLEY}`,
  },
  {
    group: 'car-horn',
    category: 'vehicle', dir: 'vehicle', count: 2, duration: 1.2, loop: false, volume: 0.85, positional: true,
    promptFor: (n) => `Car horn honking ${n === 2 ? 'twice quickly, short double beep' : 'once, single medium-length honk'}, classic sedan dual-tone horn, ${OUTDOOR}, ${FOLEY}`,
  },
  // T76 two-wheelers
  {
    group: 'bicycle-freewheel-loop',
    category: 'vehicle', dir: 'vehicle', count: 1, duration: 6, loop: true, volume: 0.5, positional: true,
    promptFor: () => 'Bicycle freewheel hub clicking rapidly while coasting, steady even ratchet ticking, constant speed, seamless loop, no voices, no music, AAA game vehicle foley',
  },
  {
    group: 'bicycle-chain-loop',
    category: 'vehicle', dir: 'vehicle', count: 1, duration: 6, loop: true, volume: 0.5, positional: true,
    promptFor: () => 'Bicycle being pedaled steadily: soft chain whir over sprockets with light mechanical rattle, constant cadence, seamless loop, no voices, no music, AAA game vehicle foley',
  },
  {
    group: 'scooter-engine-loop',
    category: 'vehicle', dir: 'vehicle', count: 1, duration: 8, loop: true, volume: 0.6, positional: true,
    promptFor: () => 'Small 50cc moped scooter engine running steadily, high-pitched buzzy two-stroke drone at constant mid RPM, seamless loop, exterior perspective, no voices, no music, AAA game vehicle sound design',
  },

  // --- water --------------------------------------------------------------------
  {
    group: 'splash-small',
    category: 'water', dir: 'water', count: 2, duration: 1.0, loop: false, volume: 0.7, positional: true,
    promptFor: (n) => `Small object plopping into a backyard swimming pool, compact splash with a few droplets falling back${n === 2 ? ', slightly deeper plunk' : ''}, ${OUTDOOR}, ${FOLEY}`,
  },
  {
    group: 'splash-large',
    category: 'water', dir: 'water', count: 2, duration: 1.8, loop: false, volume: 0.85, positional: true,
    promptFor: (n) => `Large heavy object crashing into a swimming pool, big violent splash with water sheeting and spattering back down${n === 2 ? ', slightly more spray' : ''}, ${OUTDOOR}, ${FOLEY}`,
  },
  {
    group: 'water-flow-loop',
    category: 'water', dir: 'water', count: 1, duration: 12, loop: true, volume: 0.5, positional: true,
    promptFor: () => 'Steady stream of water pouring and flowing over an edge into a pool, continuous even gurgling flow, seamless loop, constant level, no music, AAA game ambience',
  },
  {
    group: 'pool-lap-loop',
    category: 'water', dir: 'water', count: 1, duration: 12, loop: true, volume: 0.35, positional: true,
    promptFor: () => 'Calm swimming pool water gently lapping against tiled edges, soft intermittent slosh and ripple, seamless loop, quiet suburban afternoon, no music, AAA game ambience',
  },

  // --- ambience -------------------------------------------------------------------
  {
    group: 'ambience-suburb-day',
    category: 'ambience', dir: 'ambience', count: 1, duration: 22, loop: true, volume: 0.4, positional: false,
    promptFor: () => 'Peaceful suburban neighborhood daytime ambience: songbirds chirping in trees, very distant light road traffic hum, occasional soft wind through leaves, seamless loop, no voices, no music, AAA game ambience recording',
  },
  {
    group: 'wind-gust',
    category: 'ambience', dir: 'ambience', count: 2, duration: 4, loop: false, volume: 0.45, positional: false,
    promptFor: (n) => `A single gust of wind sweeping through suburban trees and around house corners, leaves rustling swelling then fading${n === 2 ? ', slightly stronger gust' : ''}, no voices, no music, AAA game ambience recording`,
  },

  // --- UI ---------------------------------------------------------------------------
  {
    group: 'ui-hover',
    category: 'ui', dir: 'ui', count: 1, duration: 0.5, loop: false, volume: 0.4, positional: false,
    promptFor: () => 'Minimal soft UI hover tick, tiny clean digital blip, subtle and short, modern AAA game interface sound, no music',
  },
  {
    group: 'ui-click',
    category: 'ui', dir: 'ui', count: 1, duration: 0.5, loop: false, volume: 0.5, positional: false,
    promptFor: () => 'Satisfying UI confirm click, crisp soft mechanical click with a warm subtle low thock, modern AAA game interface sound, no music',
  },
  {
    group: 'ui-back',
    category: 'ui', dir: 'ui', count: 1, duration: 0.5, loop: false, volume: 0.5, positional: false,
    promptFor: () => 'UI back or cancel sound, soft descending muted click, understated, modern AAA game interface sound, no music',
  },
  {
    group: 'ui-error',
    category: 'ui', dir: 'ui', count: 1, duration: 0.6, loop: false, volume: 0.5, positional: false,
    promptFor: () => 'UI error denial sound, short muted double-buzz thud, gentle not harsh, modern AAA game interface sound, no music',
  },
  {
    group: 'ui-hotbar',
    category: 'ui', dir: 'ui', count: 1, duration: 0.5, loop: false, volume: 0.45, positional: false,
    promptFor: () => 'Hotbar weapon slot switch sound, quick tactile mechanical snick like a latch, clean and short, modern AAA game interface sound, no music',
  },

  // --- player -----------------------------------------------------------------------
  {
    group: 'player-hurt',
    category: 'player', dir: 'player', count: 2, duration: 0.8, loop: false, volume: 0.7, positional: false,
    promptFor: (n) => `Adult male short pained grunt on taking a hit, breathy and restrained, ${n === 2 ? 'sharper wince' : 'low winded grunt'}, single vocalization, AAA game character foley, no music`,
  },
  {
    group: 'player-death',
    category: 'player', dir: 'player', count: 1, duration: 1.5, loop: false, volume: 0.8, positional: false,
    promptFor: () => 'Adult male death groan, a final exhausted exhale collapsing into silence, single vocalization, restrained not cartoonish, AAA game character foley, no music',
  },
  {
    group: 'heartbeat-low-health-loop',
    category: 'player', dir: 'player', count: 1, duration: 4, loop: true, volume: 0.6, positional: false,
    promptFor: () => 'Slow heavy human heartbeat, deep muffled double thump repeating steadily, seamless loop, tense low-health feeling, no music, AAA game sound design',
  },
]

// --- music (T38) ----------------------------------------------------------------
const MUSIC_TRACKS = [
  {
    id: 'music-menu',
    file: 'music/music-menu.mp3',
    lengthMs: 90_000,
    volume: 0.6,
    prompt:
      'Calm, slightly ominous ambient synth track for a video game main menu set in a quiet american suburb. ' +
      'Warm analog pads, slow evolving drones, a faint unsettling detuned edge underneath, sparse soft piano notes, ' +
      'no drums, no vocals, patient and atmospheric, loopable, cinematic production quality.',
  },
  {
    id: 'music-game-ambient',
    file: 'music/music-game-ambient.mp3',
    lengthMs: 120_000,
    volume: 0.5,
    prompt:
      'Understated ambient background bed for open-ended sandbox gameplay in a sunny suburban neighborhood. ' +
      'Airy warm synth pads, gentle slowly shifting harmonic texture, hints of soft mallets, very low intensity, ' +
      'stays out of the way, no drums, no vocals, no melody hooks, loopable, cinematic production quality.',
  },
]

// ---------------------------------------------------------------------------
// generation
// ---------------------------------------------------------------------------
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

let totalCreditsSpent = 0
let costHeaderSeen = false

/** POST with retry/backoff on 429/5xx; returns ArrayBuffer */
async function apiPost(url, body, label) {
  const maxAttempts = 6
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    let res
    try {
      res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'xi-api-key': apiKey },
        body: JSON.stringify(body),
      })
    } catch (e) {
      warn(`  network error (${label}) attempt ${attempt}: ${e.message}`)
      await sleep(2000 * attempt)
      continue
    }
    if (res.ok) {
      // usage headers if present (names vary; capture anything cost-like)
      for (const [k, v] of res.headers) {
        if (/cost|credit/i.test(k)) {
          const n = Number(v)
          if (Number.isFinite(n)) {
            totalCreditsSpent += n
            costHeaderSeen = true
          }
        }
      }
      return await res.arrayBuffer()
    }
    const text = await res.text().catch(() => '')
    if (res.status === 429 || res.status >= 500) {
      const wait = Math.min(60_000, 2000 * 2 ** (attempt - 1))
      warn(`  ${res.status} on ${label}, retrying in ${wait / 1000}s (attempt ${attempt}/${maxAttempts})`)
      await sleep(wait)
      continue
    }
    throw new Error(`API ${res.status} on ${label}: ${text.slice(0, 500)}`)
  }
  throw new Error(`giving up on ${label} after ${maxAttempts} attempts`)
}

async function exists(p) {
  try {
    await access(p)
    return true
  } catch {
    return false
  }
}

/** flat list of every sfx file the spec defines */
function sfxFiles() {
  const out = []
  for (const g of SFX_GROUPS) {
    for (let n = 1; n <= g.count; n++) {
      out.push({
        id: `${g.group}-${n}`,
        group: g.group,
        category: g.category,
        rel: `sfx/${g.dir}/${g.group}-${n}.mp3`,
        loop: g.loop,
        volume: g.volume,
        positional: g.positional,
        prompt: g.promptFor(n),
        duration: g.duration,
        promptInfluence: g.promptInfluence ?? 0.55,
      })
    }
  }
  return out
}

async function generateSfx(limit) {
  const files = sfxFiles()
  let made = 0
  let skipped = 0
  const failures = []
  for (const f of files) {
    const abs = path.join(AUDIO_DIR, f.rel)
    if (await exists(abs)) {
      skipped++
      continue
    }
    if (limit != null && made >= limit) break
    log(`gen sfx  ${f.rel}  (${f.duration}s${f.loop ? ', loop' : ''})`)
    try {
      const buf = await apiPost(
        SFX_ENDPOINT,
        {
          text: f.prompt,
          model_id: 'eleven_text_to_sound_v2',
          duration_seconds: f.duration,
          prompt_influence: f.promptInfluence,
          loop: f.loop,
        },
        f.id,
      )
      if (buf.byteLength < 1000) throw new Error(`suspiciously small response (${buf.byteLength} bytes)`)
      await mkdir(path.dirname(abs), { recursive: true })
      await writeFile(abs, Buffer.from(buf))
      made++
      await sleep(250) // gentle pacing
    } catch (e) {
      failures.push({ id: f.id, err: redact(e.message) })
      warn(`  FAILED ${f.id}: ${e.message}`)
    }
  }
  return { total: files.length, made, skipped, failures }
}

async function generateMusic(limit) {
  let made = 0
  let skipped = 0
  const failures = []
  for (const t of MUSIC_TRACKS) {
    const abs = path.join(AUDIO_DIR, t.file)
    if (await exists(abs)) {
      skipped++
      continue
    }
    if (limit != null && made >= limit) break
    log(`gen music ${t.file} (${t.lengthMs / 1000}s)`)
    try {
      let buf
      try {
        buf = await apiPost(
          MUSIC_ENDPOINT,
          {
            prompt: t.prompt,
            music_length_ms: t.lengthMs,
            model_id: 'music_v1',
            force_instrumental: true,
          },
          t.id,
        )
      } catch (e) {
        if (!/API 402|paid_plan_required/.test(e.message)) throw e
        // T38 fallback: music API is plan-gated — generate a long-form loopable
        // ambient bed via sound-generation (max 30s) instead. Noted loudly.
        warn(`  music API unavailable on this plan (402) — falling back to 30s sound-generation ambient bed for ${t.id}`)
        buf = await apiPost(
          SFX_ENDPOINT,
          {
            text: `Looping ambient music bed: ${t.prompt}`,
            model_id: 'eleven_text_to_sound_v2',
            duration_seconds: 30,
            prompt_influence: 0.5,
            loop: true,
          },
          `${t.id} (sfx fallback)`,
        )
      }
      if (buf.byteLength < 1000) throw new Error(`suspiciously small response (${buf.byteLength} bytes)`)
      await mkdir(path.dirname(abs), { recursive: true })
      await writeFile(abs, Buffer.from(buf))
      made++
    } catch (e) {
      failures.push({ id: t.id, err: redact(e.message) })
      warn(`  FAILED ${t.id}: ${e.message}`)
    }
  }
  return { total: MUSIC_TRACKS.length, made, skipped, failures }
}

// ---------------------------------------------------------------------------
// manifest — only lists files that actually exist on disk (loud about gaps)
// ---------------------------------------------------------------------------
async function writeManifest() {
  const sounds = []
  const missing = []
  for (const f of sfxFiles()) {
    if (await exists(path.join(AUDIO_DIR, f.rel))) {
      sounds.push({
        id: f.id,
        path: `/audio/${f.rel}`,
        category: f.category,
        loop: f.loop,
        volume: f.volume,
        positional: f.positional,
        roundRobin: f.group,
      })
    } else {
      missing.push(f.rel)
    }
  }
  for (const t of MUSIC_TRACKS) {
    if (await exists(path.join(AUDIO_DIR, t.file))) {
      sounds.push({
        id: t.id,
        path: `/audio/${t.file}`,
        category: 'music',
        loop: true,
        volume: t.volume,
        positional: false,
        roundRobin: t.id,
      })
    } else {
      missing.push(t.file)
    }
  }
  const manifest = { version: 1, sounds }
  await mkdir(AUDIO_DIR, { recursive: true })
  await writeFile(MANIFEST_PATH, JSON.stringify(manifest, null, 2) + '\n')
  return { count: sounds.length, missing }
}

// ---------------------------------------------------------------------------
async function main() {
  const args = process.argv.slice(2)
  const dry = args.includes('--dry')
  const only = (args.find((a) => a.startsWith('--only=')) ?? '').split('=')[1] ?? 'all'
  const limitArg = args.find((a) => a.startsWith('--limit='))
  const limit = limitArg ? Number(limitArg.split('=')[1]) : null

  const files = sfxFiles()
  if (dry) {
    for (const f of files) log(`${f.rel}  [${f.duration}s${f.loop ? ' loop' : ''}]  ${f.prompt}`)
    for (const t of MUSIC_TRACKS) log(`${t.file}  [${t.lengthMs / 1000}s]  ${t.prompt}`)
    log(`\nplan: ${files.length} sfx + ${MUSIC_TRACKS.length} music tracks`)
    return
  }

  await loadKey()

  let sfxRes = { total: files.length, made: 0, skipped: 0, failures: [], ran: false }
  let musicRes = { total: MUSIC_TRACKS.length, made: 0, skipped: 0, failures: [], ran: false }
  if (only === 'all' || only === 'sfx') sfxRes = { ...(await generateSfx(limit)), ran: true }
  if (only === 'all' || only === 'music') musicRes = { ...(await generateMusic(limit)), ran: true }

  const { count, missing } = await writeManifest()

  log('\n=== summary ===')
  log(sfxRes.ran ? `sfx:    ${sfxRes.made} generated, ${sfxRes.skipped} already present, ${sfxRes.failures.length} failed (of ${sfxRes.total})` : 'sfx:    not run (--only)')
  log(musicRes.ran ? `music:  ${musicRes.made} generated, ${musicRes.skipped} already present, ${musicRes.failures.length} failed (of ${musicRes.total})` : 'music:  not run (--only)')
  log(`manifest: ${count} entries → public/audio/manifest.json`)
  if (costHeaderSeen) log(`credits spent this run (from API headers): ${totalCreditsSpent}`)
  else log('credits: API returned no cost headers this run')
  if (missing.length) {
    warn(`MISSING from manifest (not on disk): \n  ${missing.join('\n  ')}`)
  }
  const failures = [...sfxRes.failures, ...musicRes.failures]
  if (failures.length) {
    warn(`FAILURES:\n  ${failures.map((f) => `${f.id}: ${f.err}`).join('\n  ')}`)
    process.exitCode = 1
  }
}

main().catch((e) => {
  console.error(redact(e.stack ?? e.message ?? String(e)))
  process.exit(1)
})

import './style.css';

/* =====================================================================
   Sheep Rescue — a tiny vanilla-JS canvas game.

   - Move the shepherd with WASD or the arrow keys.
   - Walk into sheep to rescue them (+1 point each); a new sheep appears.
   - Press SPACE (or click / tap) to fling a sling stone the way you're facing;
     a stone that hits a wolf drives it off for bonus points.
   - Wolves chase you and get faster the longer you survive.
   - If a wolf touches you, it's game over.
   ===================================================================== */

// ---- Tunables (all positions are in "world units": an 800x600 field) ----
const WORLD_W = 800;
const WORLD_H = 600;

const PLAYER_SPEED = 250;        // px / second
const PLAYER_R = 18;             // collision radius

const SHEEP_R = 13;
const SHEEP_COUNT = 5;           // sheep on the field at once
const SHEEP_MAX_SPEED = 120;     // sheep are always slower than the shepherd

const WOLF_R = 17;
const WOLF_BASE_SPEED = 110;
const WOLF_SPEED_GROWTH = 6;     // extra px/s per second survived
const WOLF_MAX_SPEED = 275;      // eventually slightly faster than the player
const WOLF_SPAWN_INTERVAL = 14;  // seconds between new wolves joining the hunt
const WOLF_MAX_COUNT = 5;        // wolves on the field at once

// ---- Sling projectile tunables ----
const STONE_R = 6;               // stone collision radius
const STONE_SPEED = 560;         // px / second — outpaces even a sped-up wolf
const STONE_COOLDOWN = 0.45;     // seconds you must wait between shots (anti-spam)
const WOLF_KILL_POINTS = 5;      // score awarded for downing a wolf with a stone

// ---- DOM references ----
const canvas = document.getElementById('game');
const ctx = canvas.getContext('2d');
const scoreEl = document.getElementById('score');
const wolvesEl = document.getElementById('wolves');
const timeEl = document.getElementById('time');
const startScreen = document.getElementById('startScreen');
const gameOverScreen = document.getElementById('gameOverScreen');
const finalScoreEl = document.getElementById('finalScore');
const finalWolvesEl = document.getElementById('finalWolves');
const finalTimeEl = document.getElementById('finalTime');
const bestLineEl = document.getElementById('bestLine');
const startBtn = document.getElementById('startBtn');
const restartBtn = document.getElementById('restartBtn');

// ---------------------------------------------------------------------
// Canvas sizing: keep the logical 800x600 coordinate system, but render
// at the element's real pixel size (and devicePixelRatio) so it stays
// crisp and responsive on any desktop window size.
// ---------------------------------------------------------------------
const view = { scaleX: 1, scaleY: 1 };
function resizeCanvas() {
  const rect = canvas.getBoundingClientRect();
  const dpr = window.devicePixelRatio || 1;
  canvas.width = Math.max(1, Math.round(rect.width * dpr));
  canvas.height = Math.max(1, Math.round(rect.height * dpr));
  view.scaleX = canvas.width / WORLD_W;
  view.scaleY = canvas.height / WORLD_H;
}
window.addEventListener('resize', resizeCanvas);
if (window.ResizeObserver) new ResizeObserver(resizeCanvas).observe(canvas);
resizeCanvas();

// ---------------------------------------------------------------------
// Input — track which movement keys are currently held.
// ---------------------------------------------------------------------
const keys = new Set();
const MOVE_KEYS = new Set([
  'arrowup', 'arrowdown', 'arrowleft', 'arrowright', 'w', 'a', 's', 'd',
]);
window.addEventListener('keydown', (e) => {
  const k = e.key.toLowerCase();
  if (MOVE_KEYS.has(k)) {
    keys.add(k);
    e.preventDefault(); // stop arrow keys from scrolling the page
  }
  // SPACE: fire a sling stone while playing, otherwise (re)start the game.
  if (k === ' ') {
    e.preventDefault(); // Space scrolls the page by default — never want that here
    if (state === 'playing') fireStone();
    else startGame();
  } else if (k === 'enter' && state !== 'playing') {
    startGame();
  }
});
window.addEventListener('keyup', (e) => keys.delete(e.key.toLowerCase()));
window.addEventListener('blur', () => keys.clear()); // don't get stuck moving

// Mouse / touch / pen: a press on the play area fires a stone (and starts the
// game from a menu). We turn the shepherd to face the side that was pressed
// first, so a tap to your left slings a stone to the left.
canvas.addEventListener('pointerdown', (e) => {
  e.preventDefault();
  if (state !== 'playing') { startGame(); return; }
  const rect = canvas.getBoundingClientRect();
  const worldX = ((e.clientX - rect.left) / rect.width) * WORLD_W;
  if (worldX < player.x - 4) player.facing = -1;
  else if (worldX > player.x + 4) player.facing = 1;
  fireStone();
});

// ---------------------------------------------------------------------
// Game state
// ---------------------------------------------------------------------
let state = 'start';     // 'start' | 'playing' | 'gameover'
let player, sheep, wolves, particles, decor, stones;
let score = 0;
let elapsed = 0;         // seconds survived this run
let wolvesSpawned = 0;   // how many wolves have joined this run
let wolvesDefeated = 0;  // wolves knocked out by sling stones this run
let shootTimer = 0;      // sling cooldown: counts down to 0; can fire when <= 0
let lastTime = 0;

// ---- Small helpers ----
const rand = (min, max) => min + Math.random() * (max - min);
const dist2 = (ax, ay, bx, by) => {
  const dx = ax - bx, dy = ay - by;
  return dx * dx + dy * dy;
};
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

// Pick a random spot at least `minFromPlayer` away from the shepherd.
function spawnPoint(minFromPlayer, margin = 40) {
  for (let i = 0; i < 40; i++) {
    const x = rand(margin, WORLD_W - margin);
    const y = rand(margin, WORLD_H - margin);
    if (!player || dist2(x, y, player.x, player.y) >= minFromPlayer * minFromPlayer) {
      return { x, y };
    }
  }
  return { x: margin, y: margin };
}

function makeSheep() {
  const p = spawnPoint(140);
  return { x: p.x, y: p.y, vx: rand(-1, 1), vy: rand(-1, 1), wanderT: rand(0, 2) };
}

function makeWolf() {
  // Wolves arrive from a screen edge, away from the player.
  let x = 0, y = 0;
  for (let i = 0; i < 30; i++) {
    const side = Math.floor(Math.random() * 4);
    if (side === 0) { x = rand(0, WORLD_W); y = -WOLF_R; }
    else if (side === 1) { x = rand(0, WORLD_W); y = WORLD_H + WOLF_R; }
    else if (side === 2) { x = -WOLF_R; y = rand(0, WORLD_H); }
    else { x = WORLD_W + WOLF_R; y = rand(0, WORLD_H); }
    if (!player || dist2(x, y, player.x, player.y) > 240 * 240) break;
  }
  return { x, y, vx: 0, vy: 0, facing: 1 };
}

function currentWolfSpeed() {
  return Math.min(WOLF_MAX_SPEED, WOLF_BASE_SPEED + elapsed * WOLF_SPEED_GROWTH);
}

// Static, decorative bushes & flowers — regenerated each run for variety.
function makeDecor() {
  const palette = ['#ff6f91', '#ffe08a', '#c490e4', '#ffb3c1'];
  const items = [];
  for (let i = 0; i < 26; i++) {
    items.push({
      x: rand(20, WORLD_W - 20),
      y: rand(20, WORLD_H - 20),
      kind: Math.random() < 0.4 ? 'bush' : 'flower',
      s: rand(0.7, 1.4),
      color: palette[(Math.random() * palette.length) | 0],
    });
  }
  return items;
}

function spawnBurst(x, y, color, n, speedRange, lifeRange) {
  for (let i = 0; i < n; i++) {
    const a = Math.random() * Math.PI * 2;
    const sp = rand(speedRange[0], speedRange[1]);
    particles.push({
      x, y,
      vx: Math.cos(a) * sp, vy: Math.sin(a) * sp,
      life: rand(lifeRange[0], lifeRange[1]),
      color,
    });
  }
}

// ---------------------------------------------------------------------
// Sling projectiles
// ---------------------------------------------------------------------
// Fling a stone from the shepherd in the direction he's currently facing.
// Ignored while a previous shot is still cooling down or the game isn't
// running, which is what keeps the player from spamming shots.
function fireStone() {
  if (state !== 'playing' || shootTimer > 0) return;
  shootTimer = STONE_COOLDOWN;

  // Spawn just in front of the shepherd's hands and travel purely
  // horizontally along his facing direction (+1 = right, -1 = left).
  const muzzleX = player.x + player.facing * PLAYER_R;
  const muzzleY = player.y - PLAYER_R * 0.1;
  stones.push({ x: muzzleX, y: muzzleY, vx: player.facing * STONE_SPEED, vy: 0 });

  // A tiny dust puff at the muzzle for a bit of "thwip" feedback.
  spawnBurst(muzzleX, muzzleY, '#e8e6e0', 5, [30, 90], [0.12, 0.28]);
}

// Advance every stone, drop the ones that leave the field, and knock out the
// first wolf each stone touches (circle/circle test). Called once per step.
function updateStones(dt) {
  // Tick down the shared cooldown so the next fireStone() can take.
  if (shootTimer > 0) shootTimer -= dt;

  for (let i = stones.length - 1; i >= 0; i--) {
    const st = stones[i];
    st.x += st.vx * dt;
    st.y += st.vy * dt;

    // Off the field? The stone is spent — forget it.
    if (st.x < -STONE_R || st.x > WORLD_W + STONE_R ||
        st.y < -STONE_R || st.y > WORLD_H + STONE_R) {
      stones.splice(i, 1);
      continue;
    }

    // Did this stone strike a wolf? If so, that wolf is driven off.
    for (let j = 0; j < wolves.length; j++) {
      const w = wolves[j];
      const reach = STONE_R + WOLF_R;
      if (dist2(st.x, st.y, w.x, w.y) <= reach * reach) {
        wolves.splice(j, 1);
        wolvesDefeated += 1;
        score += WOLF_KILL_POINTS;
        spawnBurst(w.x, w.y, '#b9aa96', 14, [60, 200], [0.3, 0.7]);
        stones.splice(i, 1); // a stone hits only one wolf, then it's gone
        updateHud();
        break;
      }
    }
  }
}

// ---------------------------------------------------------------------
// State transitions
// ---------------------------------------------------------------------
function resetGame() {
  player = { x: WORLD_W / 2, y: WORLD_H / 2, facing: 1 };
  sheep = [];
  for (let i = 0; i < SHEEP_COUNT; i++) sheep.push(makeSheep());
  wolves = [makeWolf()];
  wolvesSpawned = 1;
  particles = [];
  decor = makeDecor();
  stones = [];
  shootTimer = 0;
  score = 0;
  wolvesDefeated = 0;
  elapsed = 0;
  updateHud();
}

function startGame() {
  resetGame();
  state = 'playing';
  startScreen.classList.add('hidden');
  gameOverScreen.classList.add('hidden');
  lastTime = performance.now();
}

function gameOver() {
  state = 'gameover';
  stones = []; // no stragglers left frozen mid-air on the game-over screen
  spawnBurst(player.x, player.y, '#ffffff', 20, [60, 220], [0.4, 0.95]);

  finalScoreEl.textContent = score;
  finalWolvesEl.textContent = wolvesDefeated;
  finalTimeEl.textContent = Math.floor(elapsed);

  // Track a best score in localStorage (fails silently in private mode, etc).
  let best = 0;
  try { best = Number(localStorage.getItem('sheepRescueBest')) || 0; } catch { /* ignore */ }
  if (score > best) {
    best = score;
    try { localStorage.setItem('sheepRescueBest', String(best)); } catch { /* ignore */ }
    bestLineEl.textContent = 'New best score! 🏆';
  } else {
    bestLineEl.textContent = `Best score: ${best}`;
  }
  gameOverScreen.classList.remove('hidden');
}

function updateHud() {
  scoreEl.textContent = score;
  wolvesEl.textContent = wolvesDefeated;
  timeEl.textContent = Math.floor(elapsed);
}

// ---------------------------------------------------------------------
// Update (one simulation step)
// ---------------------------------------------------------------------
function update(dt) {
  elapsed += dt;

  // --- Move the shepherd from input (diagonals normalised so they aren't faster) ---
  let mx = 0, my = 0;
  if (keys.has('arrowleft') || keys.has('a')) mx -= 1;
  if (keys.has('arrowright') || keys.has('d')) mx += 1;
  if (keys.has('arrowup') || keys.has('w')) my -= 1;
  if (keys.has('arrowdown') || keys.has('s')) my += 1;
  if (mx || my) {
    const len = Math.hypot(mx, my);
    player.x += (mx / len) * PLAYER_SPEED * dt;
    player.y += (my / len) * PLAYER_SPEED * dt;
    if (mx !== 0) player.facing = mx > 0 ? 1 : -1;
  }
  player.x = clamp(player.x, PLAYER_R, WORLD_W - PLAYER_R);
  player.y = clamp(player.y, PLAYER_R, WORLD_H - PLAYER_R);

  // --- Sheep: lazy wander, plus a gentle nudge away from the shepherd and a
  //     stronger one away from wolves. They're capped well below player speed. ---
  for (const s of sheep) {
    s.wanderT -= dt;
    if (s.wanderT <= 0) {
      const a = Math.random() * Math.PI * 2;
      s.vx = Math.cos(a) * rand(15, 50);
      s.vy = Math.sin(a) * rand(15, 50);
      s.wanderT = rand(0.8, 2.4);
    }
    let fx = s.vx, fy = s.vy;

    const dpx = s.x - player.x, dpy = s.y - player.y;
    const dp = Math.hypot(dpx, dpy) || 1;
    if (dp < 85) { const f = ((85 - dp) / 85) * 70; fx += (dpx / dp) * f; fy += (dpy / dp) * f; }

    for (const w of wolves) {
      const dwx = s.x - w.x, dwy = s.y - w.y;
      const dw = Math.hypot(dwx, dwy) || 1;
      if (dw < 150) { const f = ((150 - dw) / 150) * 160; fx += (dwx / dw) * f; fy += (dwy / dw) * f; }
    }

    const sp = Math.hypot(fx, fy);
    if (sp > SHEEP_MAX_SPEED) { fx = (fx / sp) * SHEEP_MAX_SPEED; fy = (fy / sp) * SHEEP_MAX_SPEED; }
    s.x += fx * dt; s.y += fy * dt;

    // Bounce off the fence so they stay on the field.
    if (s.x < SHEEP_R) { s.x = SHEEP_R; s.vx = Math.abs(s.vx); }
    if (s.x > WORLD_W - SHEEP_R) { s.x = WORLD_W - SHEEP_R; s.vx = -Math.abs(s.vx); }
    if (s.y < SHEEP_R) { s.y = SHEEP_R; s.vy = Math.abs(s.vy); }
    if (s.y > WORLD_H - SHEEP_R) { s.y = WORLD_H - SHEEP_R; s.vy = -Math.abs(s.vy); }
  }

  // --- New wolves arrive over time (up to WOLF_MAX_COUNT on the field at once;
  //     downing one with a stone makes room for the next to come prowling). ---
  if (wolves.length < WOLF_MAX_COUNT && elapsed > wolvesSpawned * WOLF_SPAWN_INTERVAL) {
    wolves.push(makeWolf());
    wolvesSpawned++;
  }

  // --- Wolves home in on the shepherd ---
  const wolfSpeed = currentWolfSpeed();
  for (const w of wolves) {
    const dx = player.x - w.x, dy = player.y - w.y;
    const d = Math.hypot(dx, dy) || 1;
    w.vx = (dx / d) * wolfSpeed;
    w.vy = (dy / d) * wolfSpeed;
    w.x += w.vx * dt;
    w.y += w.vy * dt;
    if (dx !== 0) w.facing = dx > 0 ? 1 : -1;
    w.x = clamp(w.x, WOLF_R, WORLD_W - WOLF_R);
    w.y = clamp(w.y, WOLF_R, WORLD_H - WOLF_R);
  }

  // --- Sling stones: fly straight, despawn at the edges, KO wolves on contact ---
  updateStones(dt);

  // --- Collision: shepherd vs sheep (circle/circle) → rescue! ---
  for (let i = 0; i < sheep.length; i++) {
    const s = sheep[i];
    const reach = PLAYER_R + SHEEP_R;
    if (dist2(player.x, player.y, s.x, s.y) <= reach * reach) {
      score += 1;
      spawnBurst(s.x, s.y, '#ffd166', 10, [40, 150], [0.3, 0.7]);
      sheep[i] = makeSheep();
      updateHud();
    }
  }

  // --- Collision: shepherd vs wolf (circle/circle) → game over ---
  for (const w of wolves) {
    const reach = PLAYER_R + WOLF_R;
    if (dist2(player.x, player.y, w.x, w.y) <= reach * reach) {
      gameOver();
      break;
    }
  }

  updateParticles(dt);
  updateHud();
}

function updateParticles(dt) {
  for (let i = particles.length - 1; i >= 0; i--) {
    const p = particles[i];
    p.life -= dt;
    if (p.life <= 0) { particles.splice(i, 1); continue; }
    p.x += p.vx * dt;
    p.y += p.vy * dt;
    p.vx *= 0.92;
    p.vy *= 0.92;
  }
}

// ---------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------
function render() {
  // Map the logical world onto the (DPR-scaled) canvas.
  ctx.setTransform(view.scaleX, 0, 0, view.scaleY, 0, 0);

  drawField();
  drawDecor();

  // Draw entities back-to-front (sorted by y) for a hint of depth.
  const drawables = [];
  for (const s of sheep) drawables.push({ y: s.y, draw: () => drawSheep(s) });
  for (const w of wolves) drawables.push({ y: w.y, draw: () => drawWolf(w) });
  for (const st of stones) drawables.push({ y: st.y, draw: () => drawStone(st) });
  drawables.push({ y: player.y, draw: () => drawShepherd(player) });
  drawables.sort((a, b) => a.y - b.y);
  for (const d of drawables) d.draw();

  drawParticles();
}

function drawField() {
  // Grass base + faint "mown lawn" stripes + a wooden fence frame.
  ctx.fillStyle = '#6bbf45';
  ctx.fillRect(0, 0, WORLD_W, WORLD_H);
  ctx.fillStyle = 'rgba(255, 255, 255, 0.045)';
  for (let x = 0; x < WORLD_W; x += 64) ctx.fillRect(x, 0, 32, WORLD_H);

  ctx.lineJoin = 'round';
  ctx.strokeStyle = '#7a4a22';
  ctx.lineWidth = 12;
  ctx.strokeRect(6, 6, WORLD_W - 12, WORLD_H - 12);
  ctx.strokeStyle = '#9c6a35';
  ctx.lineWidth = 4;
  ctx.strokeRect(6, 6, WORLD_W - 12, WORLD_H - 12);
}

function drawDecor() {
  for (const d of decor) {
    ctx.save();
    ctx.translate(d.x, d.y);
    ctx.scale(d.s, d.s);
    if (d.kind === 'bush') {
      ctx.fillStyle = '#4f9e36';
      for (const [ox, oy, r] of [[-8, 2, 9], [8, 2, 9], [0, -4, 11]]) {
        ctx.beginPath(); ctx.arc(ox, oy, r, 0, Math.PI * 2); ctx.fill();
      }
    } else {
      // little 5-petal flower
      ctx.fillStyle = d.color;
      for (let i = 0; i < 5; i++) {
        const a = (i / 5) * Math.PI * 2;
        ctx.beginPath(); ctx.arc(Math.cos(a) * 4.5, Math.sin(a) * 4.5, 3, 0, Math.PI * 2); ctx.fill();
      }
      ctx.fillStyle = '#ffd166';
      ctx.beginPath(); ctx.arc(0, 0, 2.4, 0, Math.PI * 2); ctx.fill();
    }
    ctx.restore();
  }
}

// Soft contact shadow under an entity.
function drawShadow(x, y, rx) {
  ctx.fillStyle = 'rgba(0, 0, 0, 0.16)';
  ctx.beginPath();
  ctx.ellipse(x, y, rx, rx * 0.42, 0, 0, Math.PI * 2);
  ctx.fill();
}

function drawSheep(s) {
  drawShadow(s.x, s.y + SHEEP_R * 0.85, SHEEP_R * 0.95);
  ctx.save();
  ctx.translate(s.x, s.y);

  // legs
  ctx.strokeStyle = '#39312b';
  ctx.lineWidth = 3;
  ctx.lineCap = 'round';
  ctx.beginPath();
  ctx.moveTo(-5, SHEEP_R * 0.45); ctx.lineTo(-5, SHEEP_R * 1.05);
  ctx.moveTo(5, SHEEP_R * 0.45); ctx.lineTo(5, SHEEP_R * 1.05);
  ctx.stroke();

  // fluffy wool — a cluster of overlapping circles
  ctx.fillStyle = '#f7f8fa';
  const bumps = [
    [0, 0, SHEEP_R],
    [-SHEEP_R * 0.7, -2, SHEEP_R * 0.62], [SHEEP_R * 0.7, -2, SHEEP_R * 0.62],
    [-SHEEP_R * 0.45, SHEEP_R * 0.45, SHEEP_R * 0.55], [SHEEP_R * 0.45, SHEEP_R * 0.45, SHEEP_R * 0.55],
    [0, -SHEEP_R * 0.7, SHEEP_R * 0.62],
  ];
  for (const [ox, oy, r] of bumps) { ctx.beginPath(); ctx.arc(ox, oy, r, 0, Math.PI * 2); ctx.fill(); }

  // face
  ctx.fillStyle = '#2f2a2a';
  ctx.beginPath(); ctx.ellipse(0, -SHEEP_R * 0.55, SHEEP_R * 0.5, SHEEP_R * 0.42, 0, 0, Math.PI * 2); ctx.fill();
  // ears
  ctx.beginPath(); ctx.ellipse(-SHEEP_R * 0.46, -SHEEP_R * 0.6, SHEEP_R * 0.22, SHEEP_R * 0.12, -0.5, 0, Math.PI * 2); ctx.fill();
  ctx.beginPath(); ctx.ellipse(SHEEP_R * 0.46, -SHEEP_R * 0.6, SHEEP_R * 0.22, SHEEP_R * 0.12, 0.5, 0, Math.PI * 2); ctx.fill();
  // eyes
  ctx.fillStyle = '#fff';
  ctx.beginPath(); ctx.arc(-SHEEP_R * 0.16, -SHEEP_R * 0.6, SHEEP_R * 0.1, 0, Math.PI * 2); ctx.fill();
  ctx.beginPath(); ctx.arc(SHEEP_R * 0.16, -SHEEP_R * 0.6, SHEEP_R * 0.1, 0, Math.PI * 2); ctx.fill();

  ctx.restore();
}

function drawWolf(w) {
  drawShadow(w.x, w.y + WOLF_R * 0.85, WOLF_R * 1.05);
  ctx.save();
  ctx.translate(w.x, w.y);
  ctx.scale(w.facing, 1); // mirror so the wolf faces the way it's running

  // bushy tail
  ctx.fillStyle = '#6b7280';
  ctx.beginPath();
  ctx.moveTo(-WOLF_R * 0.8, 0);
  ctx.quadraticCurveTo(-WOLF_R * 1.7, -WOLF_R * 0.1, -WOLF_R * 1.5, -WOLF_R * 0.95);
  ctx.quadraticCurveTo(-WOLF_R * 1.05, -WOLF_R * 0.25, -WOLF_R * 0.7, WOLF_R * 0.25);
  ctx.fill();

  // legs
  ctx.strokeStyle = '#4b5563';
  ctx.lineWidth = 4;
  ctx.lineCap = 'round';
  ctx.beginPath();
  ctx.moveTo(-WOLF_R * 0.4, WOLF_R * 0.35); ctx.lineTo(-WOLF_R * 0.4, WOLF_R * 1.1);
  ctx.moveTo(WOLF_R * 0.45, WOLF_R * 0.35); ctx.lineTo(WOLF_R * 0.45, WOLF_R * 1.1);
  ctx.stroke();

  // body + belly highlight
  ctx.fillStyle = '#6b7280';
  ctx.beginPath(); ctx.ellipse(0, 0, WOLF_R, WOLF_R * 0.8, 0, 0, Math.PI * 2); ctx.fill();
  ctx.fillStyle = '#9aa3af';
  ctx.beginPath(); ctx.ellipse(WOLF_R * 0.1, WOLF_R * 0.28, WOLF_R * 0.7, WOLF_R * 0.42, 0, 0, Math.PI * 2); ctx.fill();

  // head
  ctx.fillStyle = '#6b7280';
  ctx.beginPath(); ctx.arc(WOLF_R * 0.78, -WOLF_R * 0.2, WOLF_R * 0.62, 0, Math.PI * 2); ctx.fill();
  // ears
  ctx.beginPath();
  ctx.moveTo(WOLF_R * 0.42, -WOLF_R * 0.68); ctx.lineTo(WOLF_R * 0.6, -WOLF_R * 1.25); ctx.lineTo(WOLF_R * 0.9, -WOLF_R * 0.72); ctx.closePath(); ctx.fill();
  ctx.beginPath();
  ctx.moveTo(WOLF_R * 0.9, -WOLF_R * 0.72); ctx.lineTo(WOLF_R * 1.18, -WOLF_R * 1.12); ctx.lineTo(WOLF_R * 1.28, -WOLF_R * 0.5); ctx.closePath(); ctx.fill();
  // snout + nose
  ctx.fillStyle = '#4b5563';
  ctx.beginPath(); ctx.ellipse(WOLF_R * 1.28, -WOLF_R * 0.02, WOLF_R * 0.42, WOLF_R * 0.3, 0, 0, Math.PI * 2); ctx.fill();
  ctx.fillStyle = '#1f2933';
  ctx.beginPath(); ctx.arc(WOLF_R * 1.62, -WOLF_R * 0.02, WOLF_R * 0.12, 0, Math.PI * 2); ctx.fill();
  // glowing eye
  ctx.fillStyle = '#ffd166';
  ctx.beginPath(); ctx.ellipse(WOLF_R * 0.98, -WOLF_R * 0.3, WOLF_R * 0.14, WOLF_R * 0.1, 0, 0, Math.PI * 2); ctx.fill();
  ctx.fillStyle = '#1f2933';
  ctx.beginPath(); ctx.arc(WOLF_R * 1.02, -WOLF_R * 0.3, WOLF_R * 0.055, 0, Math.PI * 2); ctx.fill();

  ctx.restore();
}

function drawShepherd(p) {
  drawShadow(p.x, p.y + PLAYER_R * 1.0, PLAYER_R * 1.05);
  ctx.save();
  ctx.translate(p.x, p.y);

  // shepherd's crook + a little leather sling, both on the side he's facing
  ctx.save();
  ctx.scale(p.facing, 1);
  ctx.strokeStyle = '#8a5a2b';
  ctx.lineWidth = 4;
  ctx.lineCap = 'round';
  ctx.beginPath();
  ctx.moveTo(PLAYER_R * 0.95, PLAYER_R * 1.15);
  ctx.lineTo(PLAYER_R * 0.95, -PLAYER_R * 1.5);
  ctx.arc(PLAYER_R * 0.6, -PLAYER_R * 1.5, PLAYER_R * 0.35, 0, Math.PI, true);
  ctx.stroke();

  // sling: two thin straps from his free hand down to a small pouch + pebble
  ctx.strokeStyle = '#6b4f33';
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(PLAYER_R * 1.0, PLAYER_R * 0.12);
  ctx.quadraticCurveTo(PLAYER_R * 1.5, PLAYER_R * 0.4, PLAYER_R * 1.22, PLAYER_R * 0.95);
  ctx.moveTo(PLAYER_R * 1.0, PLAYER_R * 0.12);
  ctx.quadraticCurveTo(PLAYER_R * 1.15, PLAYER_R * 0.6, PLAYER_R * 1.22, PLAYER_R * 0.95);
  ctx.stroke();
  ctx.fillStyle = '#7d7264';
  ctx.beginPath();
  ctx.arc(PLAYER_R * 1.2, PLAYER_R * 0.86, PLAYER_R * 0.15, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();

  // legs
  ctx.strokeStyle = '#3b2f2a';
  ctx.lineWidth = 5;
  ctx.lineCap = 'round';
  ctx.beginPath();
  ctx.moveTo(-PLAYER_R * 0.35, PLAYER_R * 0.75); ctx.lineTo(-PLAYER_R * 0.35, PLAYER_R * 1.3);
  ctx.moveTo(PLAYER_R * 0.35, PLAYER_R * 0.75); ctx.lineTo(PLAYER_R * 0.35, PLAYER_R * 1.3);
  ctx.stroke();

  // tunic / cloak
  ctx.fillStyle = '#3f7d5c';
  ctx.beginPath();
  ctx.moveTo(-PLAYER_R * 0.85, PLAYER_R * 0.85);
  ctx.lineTo(PLAYER_R * 0.85, PLAYER_R * 0.85);
  ctx.lineTo(PLAYER_R * 0.55, -PLAYER_R * 0.4);
  ctx.quadraticCurveTo(0, -PLAYER_R * 0.75, -PLAYER_R * 0.55, -PLAYER_R * 0.4);
  ctx.closePath();
  ctx.fill();

  // arms
  ctx.strokeStyle = '#e3ab7e';
  ctx.lineWidth = 5;
  ctx.beginPath();
  ctx.moveTo(-PLAYER_R * 0.5, -PLAYER_R * 0.2); ctx.lineTo(-PLAYER_R * 0.9, PLAYER_R * 0.35);
  ctx.moveTo(PLAYER_R * 0.5, -PLAYER_R * 0.2); ctx.lineTo(PLAYER_R * 0.92, PLAYER_R * 0.15);
  ctx.stroke();

  // head
  ctx.fillStyle = '#f0c39b';
  ctx.beginPath(); ctx.arc(0, -PLAYER_R * 0.72, PLAYER_R * 0.5, 0, Math.PI * 2); ctx.fill();
  // hat (cap + brim)
  ctx.fillStyle = '#8a5a2b';
  ctx.beginPath(); ctx.arc(0, -PLAYER_R * 1.18, PLAYER_R * 0.34, Math.PI, 0); ctx.fill();
  ctx.beginPath(); ctx.ellipse(0, -PLAYER_R * 1.05, PLAYER_R * 0.78, PLAYER_R * 0.17, 0, 0, Math.PI * 2); ctx.fill();
  // eyes
  ctx.fillStyle = '#3b2f2a';
  ctx.beginPath(); ctx.arc(-PLAYER_R * 0.16, -PLAYER_R * 0.74, PLAYER_R * 0.07, 0, Math.PI * 2); ctx.fill();
  ctx.beginPath(); ctx.arc(PLAYER_R * 0.16, -PLAYER_R * 0.74, PLAYER_R * 0.07, 0, Math.PI * 2); ctx.fill();

  ctx.restore();
}

// A flung sling stone: a little grey pebble with a short motion streak
// trailing in the direction it came from, so the shot reads as fast-moving.
function drawStone(st) {
  const speed = Math.hypot(st.vx, st.vy) || 1;
  const tx = -(st.vx / speed) * 16, ty = -(st.vy / speed) * 16;

  ctx.strokeStyle = 'rgba(120, 110, 95, 0.45)';
  ctx.lineWidth = STONE_R * 1.2;
  ctx.lineCap = 'round';
  ctx.beginPath();
  ctx.moveTo(st.x, st.y);
  ctx.lineTo(st.x + tx, st.y + ty);
  ctx.stroke();

  ctx.fillStyle = '#7d7264';
  ctx.beginPath();
  ctx.arc(st.x, st.y, STONE_R, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = '#a89c8a';
  ctx.beginPath();
  ctx.arc(st.x - STONE_R * 0.3, st.y - STONE_R * 0.3, STONE_R * 0.42, 0, Math.PI * 2);
  ctx.fill();
}

function drawParticles() {
  for (const p of particles) {
    ctx.globalAlpha = clamp(p.life * 2, 0, 1);
    ctx.fillStyle = p.color;
    ctx.beginPath();
    ctx.arc(p.x, p.y, 3, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.globalAlpha = 1;
}

// ---------------------------------------------------------------------
// Main loop
// ---------------------------------------------------------------------
function frame(now) {
  // Clamp dt so a backgrounded tab doesn't teleport everything on return.
  const dt = Math.min(0.033, (now - lastTime) / 1000) || 0;
  lastTime = now;

  if (state === 'playing') {
    update(dt);
  } else {
    // Keep particles (e.g. the game-over puff) animating on the menus.
    updateParticles(dt);
  }

  render();
  requestAnimationFrame(frame);
}

// ---- Wire up buttons & boot ----
startBtn.addEventListener('click', startGame);
restartBtn.addEventListener('click', startGame);

resetGame();             // build a static scene to sit behind the start screen
state = 'start';
lastTime = performance.now();
requestAnimationFrame(frame);

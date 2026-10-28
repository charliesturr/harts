// =====================================================
//  SURF: riding physics + a camera that follows you
// =====================================================

// Grab the canvas and its 2D drawing tool
const canvas = document.getElementById("game");
const ctx = canvas.getContext("2d");

// ---------- Tuning knobs: play with these! ----------
const LIP_Y = 90;        // top of the wave face (screen y), near the peak
const BOTTOM_Y = 150;    // bottom of the wave face
const GRAVITY = 220;     // how much dropping down the face speeds you up
const WAVE_PUSH = 60;    // forward push from the wave, strongest in the "pocket"
const DRAG = 0.35;       // water resistance (share of speed lost per second)
const TURN_RATE = 2.0;   // how fast you carve (radians per second)
const MAX_ANGLE = 1.2;   // steepest you can point up or down (~69 degrees)
const MIN_SPEED = 30;
const MAX_SPEED = 240;
const CURL_SPEED = 75;   // how fast the breaking part of the wave chases you
const BARREL_LENGTH = 110; // how far the hollow tube reaches ahead of the curl

// ---------- Colors (a small palette keeps it looking 16-bit) ----------
const SKY = ["#4fb8e0", "#6fd0ea", "#9fe2ef"]; // top -> horizon
const SUN = "#fff3b0";
const CLOUD = "#e6f8ff";
const ISLAND = "#3c7a5a";
const ISLAND_DARK = "#2e5e48";
const SEA_BACK = "#2b8ac0";
const FACE = ["#9ff0e0", "#6fdcd4", "#3fb4cc", "#2a90bc", "#1f72a4", "#185a8a"]; // lip -> bottom
const TUBE = ["#0a2f4c", "#0d3a5c", "#124a70"]; // inside the barrel, top -> bottom
const TUBE_STREAK = "#1d5c86";
const CURTAIN = ["#a8eef0", "#7fdce4", "#55c4d8", "#3aa6c8"]; // by the curl -> far end
const LIP = "#d8fbff";
const STREAK = "#b8f0ff";
const FOAM = "#eef9ff";
const FOAM_SHADE = "#c4e2f0";
const SHALLOWS = "#2f78a8";
const SHALLOWS_LIGHT = "#4a94c0";
const SAND = "#e8d08a";
const WET_SAND = "#c9ad68";
const WETSUIT = "#1a1a2e";
const SKIN = "#f2c79a";
const HAIR = "#5a3a1a";

// ---------- Game state ----------
const keys = {};       // which keys are held down right now
let surfer;            // { x, y, speed, angle }
let curlX;             // world x of the breaking curl
let cameraX;           // world x of the screen's left edge
let spray;             // list of water-spray particles
let mist;              // spray blowing off the top of the lip
let trail;             // recent board positions, drawn as a wake
let caughtTimer;       // > 0 while showing the wipeout message
let caughtMessage;     // what got you
let wasCarving;        // was space held last frame?
let fanCooldown;       // stops spray fans firing every frame
let elapsed = 0;       // seconds since the game started (for animation)

function reset() {
  surfer = { x: 0, y: 100, speed: 110, angle: 0.3 };
  curlX = -140;
  cameraX = surfer.x - canvas.width / 2;
  spray = [];
  mist = [];
  trail = [];
  caughtTimer = 0;
  wasCarving = false;
  fanCooldown = 0;
}

// ---------- Input ----------
window.addEventListener("keydown", (e) => {
  if (e.code === "Space") e.preventDefault(); // stop the page scrolling
  startAudio(); // browsers only allow sound after a key press or click
  if (e.code === "KeyM" && !e.repeat) toggleMute();
  keys[e.code] = true;
});
window.addEventListener("keyup", (e) => {
  keys[e.code] = false;
});

// ---------- Helpers ----------
function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

// A repeatable "random" number between 0 and 1 for any input number.
// Same input always gives the same output, so scenery doesn't flicker.
function hash(n) {
  const s = Math.sin(n * 12.9898) * 43758.5453;
  return s - Math.floor(s);
}

// The wave isn't the same height everywhere: it stands tallest by the curl
// and gets lower and softer out on the "shoulder" ahead of it.
function lipAt(worldX) {
  const ahead = worldX - curlX;
  const shoulder = clamp((ahead - 40) / 260, 0, 1); // 0 by the curl, 1 far ahead
  let lip = LIP_Y - 8 + shoulder * 24;
  // The wave stands up even taller where it's barreling
  if (ahead >= 0 && ahead < BARREL_LENGTH) {
    lip -= 10 * Math.sin((Math.PI * ahead) / BARREL_LENGTH);
  }
  return lip;
}

// The shape of the barrel at one point along the wave, or null if
// that point isn't barreling. Two curves define it:
//  - curtainBottom: the lower edge of the lip as it throws out. It's almost
//    level at the far end and sweeps steeply down to land by the curl.
//  - cavityBottom: the floor of the dark hollow underneath it.
function barrelAt(worldX) {
  const ahead = worldX - curlX;
  if (ahead < 0 || ahead >= BARREL_LENGTH) return null;
  const t = ahead / BARREL_LENGTH; // 0 at the curl, 1 at the far end
  const u = 1 - t;
  const lip = lipAt(worldX);
  const height = BOTTOM_Y - lip;
  const drop = 1 - Math.sqrt(1 - u * u); // a quarter-circle curve
  const curtainBottom = lip + height * drop;
  const cavityBottom = Math.min(BOTTOM_Y, curtainBottom + height * 0.6 * Math.pow(u, 0.6));
  return { t, lip, curtainBottom, cavityBottom };
}

// ---------- Sound ----------
// All the sounds are made from white noise (random numbers), filtered:
// low frequencies only = ocean rumble, high frequencies only = spray hiss.
let audio = null;
let muted = false;

function startAudio() {
  if (audio) return;
  const ac = new AudioContext();

  // Two seconds of white noise that we can loop forever
  const buffer = ac.createBuffer(1, ac.sampleRate * 2, ac.sampleRate);
  const data = buffer.getChannelData(0);
  for (let i = 0; i < data.length; i++) {
    data[i] = Math.random() * 2 - 1;
  }
  function noise() {
    const source = ac.createBufferSource();
    source.buffer = buffer;
    source.loop = true;
    source.start();
    return source;
  }

  // Ocean rumble: keep only the low end of the noise
  const rumbleFilter = ac.createBiquadFilter();
  rumbleFilter.type = "lowpass";
  rumbleFilter.frequency.value = 350;
  const rumbleGain = ac.createGain();
  rumbleGain.gain.value = 0;
  noise().connect(rumbleFilter).connect(rumbleGain).connect(ac.destination);

  // Spray hiss: keep only the high end, and only turn it up while carving
  const hissFilter = ac.createBiquadFilter();
  hissFilter.type = "highpass";
  hissFilter.frequency.value = 2500;
  const hissGain = ac.createGain();
  hissGain.gain.value = 0;
  noise().connect(hissFilter).connect(hissGain).connect(ac.destination);

  audio = { ac, rumbleGain, hissGain };
}

function toggleMute() {
  if (!audio) return;
  muted = !muted;
  if (muted) audio.ac.suspend();
  else audio.ac.resume();
}

// Glide each volume toward its target, so it never clicks or jumps
function updateAudio(rumble, hiss) {
  if (!audio) return;
  const now = audio.ac.currentTime;
  audio.rumbleGain.gain.setTargetAtTime(rumble, now, 0.15);
  audio.hissGain.gain.setTargetAtTime(hiss, now, 0.05);
}

// ---------- Particles ----------
function sprayFan(count) {
  for (let i = 0; i < count; i++) {
    const life = 0.6 + Math.random() * 0.5;
    spray.push({
      x: surfer.x - 6,
      y: surfer.y - 2,
      vx: -50 - Math.random() * 90,
      vy: -50 - Math.random() * 110,
      size: 1 + Math.floor(Math.random() * 3),
      life,
      maxLife: life,
    });
  }
}

// ---------- Update: move everything a little ----------
function update(dt) {
  elapsed += dt;

  if (caughtTimer > 0) {
    caughtTimer -= dt;
    updateAudio(0.7, 0);
    if (caughtTimer <= 0) reset();
    return;
  }

  // 1. Steering: hold space to turn up the face, let go to turn down it.
  //    Angle 0 = riding flat; negative = pointing up; positive = pointing down.
  if (keys.Space) {
    surfer.angle -= TURN_RATE * dt;
  } else {
    surfer.angle += TURN_RATE * dt;
  }
  surfer.angle = clamp(surfer.angle, -MAX_ANGLE, MAX_ANGLE);

  // 2. Speed. Downhill speeds you up and uphill slows you down,
  //    the wave pushes you along in the pocket, and drag always slows you.
  const lip = lipAt(surfer.x);
  const depth = (surfer.y - lip) / (BOTTOM_Y - lip); // 0 at lip, 1 at bottom
  const push = WAVE_PUSH * Math.max(0, 1 - Math.abs(depth - 0.35) * 2);
  surfer.speed += GRAVITY * Math.sin(surfer.angle) * dt;
  surfer.speed += push * dt;
  surfer.speed -= DRAG * surfer.speed * dt;
  surfer.speed = clamp(surfer.speed, MIN_SPEED, MAX_SPEED);

  // 3. Move in the direction the board is pointing
  surfer.x += Math.cos(surfer.angle) * surfer.speed * dt;
  surfer.y += Math.sin(surfer.angle) * surfer.speed * dt;

  // 4. Stay on the wave face (flatten out at the top and bottom)
  fanCooldown -= dt;
  if (surfer.y > BOTTOM_Y) {
    surfer.y = BOTTOM_Y;
    surfer.angle = Math.min(surfer.angle, 0);
  }
  if (surfer.y < lip) {
    // Smacking the lip with speed throws a big fan of spray
    if (surfer.angle < -0.3 && surfer.speed > 90 && fanCooldown <= 0) {
      sprayFan(25);
      fanCooldown = 0.4;
    }
    surfer.y = lip;
    surfer.angle = Math.max(surfer.angle, 0);
  }

  // 5. Spray: a steady stream while carving, and a fan when you
  //    snap back down off the top of the wave (a "top turn")
  const carving = keys.Space && surfer.speed > 80;
  if (carving) {
    spray.push({
      x: surfer.x - 6,
      y: surfer.y,
      vx: -surfer.speed * 0.3 + (Math.random() - 0.5) * 30,
      vy: -40 - Math.random() * 60,
      size: 1 + Math.floor(Math.random() * 2),
      life: 0.5,
      maxLife: 0.5,
    });
  }
  if (wasCarving && !keys.Space && depth < 0.35 && surfer.speed > 70 && fanCooldown <= 0) {
    sprayFan(18);
    fanCooldown = 0.4;
  }
  wasCarving = keys.Space;

  for (const p of spray) {
    p.vy += 200 * dt; // gravity
    p.x += p.vx * dt;
    p.y += p.vy * dt;
    p.life -= dt;
  }
  spray = spray.filter((p) => p.life > 0);

  // Offshore wind blows a fine mist back off the top of the lip
  if (Math.random() < 0.6) {
    const x = cameraX + Math.random() * canvas.width;
    if (x > curlX) {
      mist.push({ x, y: lipAt(x) - 2, life: 0.8 });
    }
  }
  for (const m of mist) {
    m.x -= 30 * dt;
    m.y -= 14 * dt;
    m.life -= dt;
  }
  mist = mist.filter((m) => m.life > 0);

  // Wake: remember where the board has been
  trail.push({ x: surfer.x, y: surfer.y });
  if (trail.length > 45) trail.shift();

  // 6. The curl chases you. If it catches you, you wipe out.
  //    Inside the barrel you have to stay below the falling lip, too.
  curlX += CURL_SPEED * dt;
  const barrel = barrelAt(surfer.x);
  if (curlX > surfer.x - 4) {
    caughtTimer = 1.5;
    caughtMessage = "CAUGHT INSIDE!";
  } else if (barrel && surfer.y < barrel.curtainBottom - 2) {
    caughtTimer = 1.5;
    caughtMessage = "HIT BY THE LIP!";
  }

  // 7. Camera: glide toward the spot that puts the surfer in the middle
  const targetX = surfer.x - canvas.width / 2;
  cameraX += (targetX - cameraX) * Math.min(1, 6 * dt);

  // Sound: the rumble gets louder as the curl gets closer
  const gap = surfer.x - curlX;
  const rumble = 0.12 + 0.35 * clamp(1 - gap / 250, 0, 1);
  const hiss = carving ? 0.08 * (surfer.speed / MAX_SPEED) : 0;
  updateAudio(rumble, hiss);
}

// ---------- Draw: paint the current state ----------
function draw() {
  drawSky();
  drawWave();
  drawShore();
  drawWake();

  // Surfer, or a tumbling board if you got caught
  if (caughtTimer <= 0) {
    drawSurfer(Math.floor(surfer.x - cameraX), Math.floor(surfer.y));
  } else {
    drawLostBoard(Math.floor(surfer.x - cameraX), Math.floor(surfer.y));
  }

  // The barrel's lip is drawn AFTER the surfer, so it falls in front of them
  drawBarrelLip();
  drawWhitewater();
  drawSpray();
  drawHud();
}

function drawSky() {
  const W = canvas.width;

  // Sky in three bands, lighter toward the horizon
  const bandHeight = 55 / SKY.length;
  for (let i = 0; i < SKY.length; i++) {
    ctx.fillStyle = SKY[i];
    ctx.fillRect(0, Math.floor(i * bandHeight), W, Math.ceil(bandHeight));
  }

  // The sun is so far away it doesn't move at all
  ctx.fillStyle = SUN;
  ctx.fillRect(176, 22, 12, 12);
  ctx.fillRect(174, 24, 16, 8);

  // Clouds and islands scroll slower than the wave (parallax),
  // which makes them feel far away.
  const cloudOffset = -(cameraX * 0.05) % 200;
  ctx.fillStyle = CLOUD;
  for (let i = -1; i < 3; i++) {
    const x = Math.floor(cloudOffset + i * 200);
    ctx.fillRect(x + 20, 14, 30, 5);
    ctx.fillRect(x + 28, 10, 16, 4);
  }
  const islandOffset = -(cameraX * 0.15) % 300;
  for (let i = -1; i < 3; i++) {
    const x = Math.floor(islandOffset + i * 300);
    ctx.fillStyle = ISLAND;
    ctx.fillRect(x, 48, 60, 7);
    ctx.fillRect(x + 10, 44, 38, 4);
    ctx.fillRect(x + 20, 41, 16, 3);
    ctx.fillStyle = ISLAND_DARK;
    ctx.fillRect(x + 30, 48, 30, 7);
  }

  // Open ocean behind the wave, with the sun glinting on it
  ctx.fillStyle = SEA_BACK;
  ctx.fillRect(0, 55, W, BOTTOM_Y - 55);
  ctx.fillStyle = SUN;
  for (let i = 0; i < 6; i++) {
    if (hash(i + Math.floor(elapsed * 4)) > 0.5) {
      ctx.fillRect(172 + Math.floor(hash(i * 7) * 22), 57 + i * 2, 3, 1);
    }
  }
}

function drawWave() {
  const W = canvas.width;

  // Draw the wave one 2-pixel-wide column at a time, so its height
  // and shape can change along its length.
  for (let sx = 0; sx < W; sx += 2) {
    const worldX = cameraX + sx;
    const ahead = worldX - curlX;
    if (ahead < 0) continue; // already broken; the whitewater covers this

    const lip = lipAt(worldX);
    const height = BOTTOM_Y - lip;

    // Color bands squeezed together near the top: that makes the face look
    // concave, steep at the lip and flattening out at the bottom.
    for (let i = 0; i < FACE.length; i++) {
      const top = lip + height * Math.pow(i / FACE.length, 1.5);
      const bottom = lip + height * Math.pow((i + 1) / FACE.length, 1.5);
      ctx.fillStyle = FACE[i];
      ctx.fillRect(sx, Math.floor(top), 2, Math.ceil(bottom - top) + 1);
    }

    // Shadow in the bowl: the face is darker where it's steepest
    const shadowReach = BARREL_LENGTH + 60;
    if (ahead < shadowReach) {
      ctx.fillStyle = "rgba(5, 30, 60," + (0.35 * (1 - ahead / shadowReach)).toFixed(2) + ")";
      ctx.fillRect(sx, Math.floor(lip), 2, Math.ceil(height));
    }

    // The barrel's dark hollow, in bands, with a few streaks of light inside
    const barrel = barrelAt(worldX);
    if (barrel) {
      const top = barrel.curtainBottom;
      const span = barrel.cavityBottom - top;
      for (let i = 0; i < TUBE.length; i++) {
        ctx.fillStyle = TUBE[i];
        ctx.fillRect(sx, Math.floor(top + (span * i) / TUBE.length), 2, Math.ceil(span / TUBE.length) + 1);
      }
      ctx.fillStyle = TUBE_STREAK;
      for (let k = 1; k <= 3; k++) {
        if (hash(Math.floor(worldX / 6) * 7 + k) > 0.45) {
          ctx.fillRect(sx, Math.floor(top + span * (k / 4)), 2, 1);
        }
      }
      continue; // the lip over the barrel is drawn later, in front of the surfer
    }

    // The lip: thick near the barrel, thin out on the shoulder
    const thickness = 2 + Math.round(4 * clamp(1 - (ahead - BARREL_LENGTH) / 60, 0, 1));
    ctx.fillStyle = LIP;
    ctx.fillRect(sx, Math.floor(lip) - thickness + 1, 2, thickness);
  }

  // Streaks on the face. They're fixed in the world, so they slide past
  // as the camera moves. That's what makes it feel like you're moving.
  ctx.fillStyle = STREAK;
  const spacing = 18;
  for (let wx = Math.floor(cameraX / spacing) * spacing; wx < cameraX + W; wx += spacing) {
    if (wx < curlX + BARREL_LENGTH) continue;
    const r = hash(wx);
    const lip = lipAt(wx);
    const y = lip + 4 + Math.floor(r * (BOTTOM_Y - lip - 8));
    ctx.fillRect(Math.floor(wx - cameraX), y, 4 + Math.floor(r * 10), 1);
  }

  // Mist blowing off the lip
  ctx.fillStyle = FOAM;
  for (const m of mist) {
    if (m.life > 0.3 || hash(m.x) > 0.5) {
      ctx.fillRect(Math.floor(m.x - cameraX), Math.floor(m.y), 1, 1);
    }
  }
}

function drawBarrelLip() {
  const W = canvas.width;
  const sprayFlicker = Math.floor(elapsed * 10);

  for (let sx = 0; sx < W; sx += 2) {
    const worldX = cameraX + sx;
    const barrel = barrelAt(worldX);
    if (!barrel) continue;
    const { t, lip, curtainBottom } = barrel;

    // The curtain of water throwing out over the hollow:
    // light and glassy by the curl, deeper blue at the far end
    ctx.fillStyle = CURTAIN[Math.min(CURTAIN.length - 1, Math.floor(t * CURTAIN.length))];
    ctx.fillRect(sx, Math.floor(lip) - 2, 2, Math.ceil(curtainBottom - lip) + 2);

    // Falling streaks of water in the curtain
    if (hash(Math.floor(worldX / 2)) > 0.6) {
      ctx.fillStyle = LIP;
      const y = lip + (curtainBottom - lip) * hash(Math.floor(worldX / 2) + 1);
      ctx.fillRect(sx, Math.floor(y), 1, 3);
    }

    // Bright leading edge where the lip catches the light
    ctx.fillStyle = LIP;
    ctx.fillRect(sx, Math.floor(curtainBottom) - 1, 2, 2);

    // Spray feathering off the top of the lip, thickest in the middle
    const sprayHeight = 2 + Math.floor(6 * Math.sin(Math.PI * t));
    ctx.fillStyle = FOAM;
    for (let y = 0; y < sprayHeight; y += 2) {
      if (hash(Math.floor(worldX / 2) * 31 + y + sprayFlicker) > 0.35) {
        ctx.fillRect(sx, Math.floor(lip) - 2 - y, 2, 2);
      }
    }
  }
}

function drawShore() {
  const W = canvas.width;

  // Shallows with ripples that slide past slightly faster than the wave
  // (they're closer to us, so more parallax)
  ctx.fillStyle = SHALLOWS;
  ctx.fillRect(0, BOTTOM_Y, W, 30);
  ctx.fillStyle = SHALLOWS_LIGHT;
  const ripple = 30;
  const shallowsX = cameraX * 1.2;
  for (let wx = Math.floor(shallowsX / ripple) * ripple; wx < shallowsX + W; wx += ripple) {
    const r = hash(wx + 3);
    ctx.fillRect(Math.floor(wx - shallowsX), BOTTOM_Y + 4 + Math.floor(r * 14), 8 + Math.floor(r * 10), 1);
  }

  // The shoreline washes up and down the sand
  const shoreY = BOTTOM_Y + 20 + Math.round(Math.sin(elapsed * 1.3) * 2);
  ctx.fillStyle = WET_SAND;
  ctx.fillRect(0, shoreY, W, 4);
  ctx.fillStyle = SAND;
  ctx.fillRect(0, shoreY + 4, W, canvas.height - shoreY - 4);
  ctx.fillStyle = FOAM;
  for (let sx = 0; sx < W; sx += 3) {
    if (hash(Math.floor((sx + shallowsX) / 3)) > 0.3) {
      ctx.fillRect(sx, shoreY - 1, 3, 1);
    }
  }
}

function drawWhitewater() {
  const curlScreenX = Math.floor(curlX - cameraX);
  if (curlScreenX <= 0) return;

  const churn = Math.floor(elapsed * 8); // changes 8 times a second

  for (let sx = 0; sx < curlScreenX + 8; sx += 2) {
    const worldX = Math.floor((cameraX + sx) / 2);

    // A bubbling, uneven top edge: it explodes up where the lip lands,
    // then settles lower further behind the curl
    const behind = clamp((curlX - (cameraX + sx)) / 140, 0, 1);
    const settle = Math.sin(Math.min(1, behind * 3) * (Math.PI / 2)); // fast at first
    const top = Math.floor(LIP_Y - 14 + settle * 40) - Math.floor(hash(worldX + churn) * 8);
    let bottom = BOTTOM_Y + 14;

    // The leading edge is ragged, not a straight wall
    if (sx >= curlScreenX) {
      const edge = (sx - curlScreenX) / 8;
      if (hash(worldX * 3 + churn) < edge) continue;
      bottom = BOTTOM_Y - Math.floor(edge * 30);
    }

    ctx.fillStyle = FOAM;
    ctx.fillRect(sx, top, 2, bottom - top);

    // Shading so it reads as churning foam, not a flat white block
    ctx.fillStyle = FOAM_SHADE;
    for (let y = top + 4; y < bottom; y += 4) {
      if (hash(worldX * 13 + y + churn) > 0.72) {
        ctx.fillRect(sx, y, 2, 2);
      }
    }
  }
}

function drawWake() {
  // Older points are drawn sparser, so the wake fades out behind you
  ctx.fillStyle = FOAM;
  for (let i = 0; i < trail.length; i++) {
    const age = trail.length - i; // 1 = newest
    if (age > 12 && i % 3 !== 0) continue;
    const p = trail[i];
    const width = age < 10 ? 2 : 1;
    ctx.fillRect(Math.floor(p.x - cameraX) - 6, Math.floor(p.y) + 1, width, 1);
  }
}

function drawSpray() {
  for (const p of spray) {
    // Particles shrink as they fade out
    const size = Math.max(1, Math.round(p.size * (p.life / p.maxLife)));
    ctx.fillStyle = p.life / p.maxLife > 0.4 ? FOAM : FOAM_SHADE;
    ctx.fillRect(Math.floor(p.x - cameraX), Math.floor(p.y), size, size);
  }
}

function drawHud() {
  ctx.font = "8px monospace";
  drawText("SPEED " + Math.round(surfer.speed), 6, 10);
  drawText("DIST " + Math.max(0, Math.round(surfer.x / 10)) + "m", 6, 20);
  drawText("HOLD SPACE: CARVE UP", 210, 10);
  drawText(muted ? "M: SOUND OFF" : "M: SOUND ON", 252, 20);
  if (caughtTimer > 0) {
    drawText(caughtMessage, 124, 40);
  }
}

// White text with a dark shadow so it's readable on any background
function drawText(text, x, y) {
  ctx.fillStyle = "#10203a";
  ctx.fillText(text, x + 1, y + 1);
  ctx.fillStyle = "#ffffff";
  ctx.fillText(text, x, y);
}

function drawBoard(x, y, angle) {
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(angle);
  ctx.fillStyle = "#fff4c0";
  ctx.fillRect(-10, -1, 20, 3);
  ctx.fillStyle = "#c8b880";
  ctx.fillRect(-10, 1, 20, 1); // rail shadow
  ctx.fillStyle = "#e04040";
  ctx.fillRect(5, -1, 4, 2); // nose stripe
  ctx.restore();
}

function drawSurfer(x, y) {
  drawBoard(x, y, surfer.angle);

  // Crouch low when carving hard; stand taller when cruising
  const carving = keys.Space;
  const crouch = carving ? 3 : surfer.angle > 0.5 ? 1 : 0;
  const lean = Math.round(surfer.angle * 3); // lean into the turn
  const hipY = y - 6 + crouch;

  // Legs: bent knees push out when crouching
  ctx.fillStyle = WETSUIT;
  ctx.fillRect(x - 5, y - 2, 2, 2);                 // back foot
  ctx.fillRect(x + 3, y - 2, 2, 2);                 // front foot
  ctx.fillRect(x - 4 - (crouch > 1 ? 1 : 0), hipY + 1, 2, y - 2 - hipY - 1); // back leg
  ctx.fillRect(x + 2 + (crouch > 1 ? 1 : 0), hipY + 1, 2, y - 2 - hipY - 1); // front leg

  // Torso and head
  ctx.fillRect(x - 3 + lean, hipY - 6, 6, 7);
  ctx.fillStyle = SKIN;
  ctx.fillRect(x - 2 + lean, hipY - 10, 4, 4);
  ctx.fillStyle = HAIR;
  ctx.fillRect(x - 2 + lean, hipY - 10, 4, 1);
  ctx.fillRect(x - 3 + lean, hipY - 10, 1, 2);

  // Arms
  ctx.fillStyle = WETSUIT;
  if (carving) {
    // Back hand drags down toward the wave, front arm points the way
    ctx.fillRect(x - 6 + lean, hipY - 4, 3, 1);
    ctx.fillRect(x - 7 + lean, hipY - 3, 1, 3);
    ctx.fillRect(x + 3 + lean, hipY - 6, 3, 1);
    ctx.fillStyle = SKIN;
    ctx.fillRect(x - 7 + lean, hipY, 1, 1);
    ctx.fillRect(x + 6 + lean, hipY - 7, 1, 1);
  } else {
    // Arms out for balance, bobbing a little
    const bob = Math.round(Math.sin(elapsed * 6));
    ctx.fillRect(x - 6 + lean, hipY - 5 + bob, 3, 1);
    ctx.fillRect(x + 3 + lean, hipY - 5 - bob, 3, 1);
    ctx.fillStyle = SKIN;
    ctx.fillRect(x - 7 + lean, hipY - 5 + bob, 1, 1);
    ctx.fillRect(x + 6 + lean, hipY - 5 - bob, 1, 1);
  }
}

function drawLostBoard(x, y) {
  // The board cartwheels through the whitewater
  const tumble = 1.5 - caughtTimer;
  drawBoard(x - tumble * 20, y - 10 - Math.sin(tumble * 4) * 10, tumble * 9);
}

// ---------- The game loop ----------
// requestAnimationFrame tells us the time in milliseconds. We use the gap
// since the last frame (dt, in seconds) so the game runs at the same speed
// on a 60Hz laptop and a 120Hz screen.
let lastTime = 0;
function loop(time) {
  const dt = Math.min((time - lastTime) / 1000, 1 / 30);
  lastTime = time;
  update(dt);
  draw();
  requestAnimationFrame(loop);
}

reset();
requestAnimationFrame(loop);

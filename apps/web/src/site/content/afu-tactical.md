Space combat in A Final Unity runs in real time, in 3D. The Enterprise and the enemy ships fly, fire phaser banks and photon torpedoes, raise shields and take damage unit by unit, while the tactical console's six pages (Phasers, Torpedoes, Damage, Conn, Tactics and Sensors) give orders and report back. The remake keeps every rule of that fight exactly as it was, and changes how it looks, sounds and handles.

## The fight itself is unchanged

The combat simulation is a line-by-line port of the reconstruction in ScummVM's Unity engine, not a rebuild from watching the game. It keeps the original's fixed step of 66 ms, about fifteen steps a second, and its own random number generator, called in the same order. It even keeps its 32-bit float rounding and its own sine and cosine tables. The battle runs on that clock, never on the screen's frame rate, so it plays the same on a fast desktop and on a phone.

Everything behind a battle comes across:

- **The damage model:** shields absorb hits, units take weighted damage, and the ship suffers critical hits, collisions, debris and hull breaches.
- **The enemy:** its AI picks a strategy, holds its range, avoids collisions, retreats, warps away and goes back to a starbase for repairs. Each ship flies its own tactics script from the original files.
- **Delegate**, which hands the ship to the crew to fly, works as it did.
- **Damage carries over.** Whatever a battle breaks stays broken on the ship afterwards, until engineering or a starbase repairs it.
- **Saving is refused during a battle**, as in the original.

The original's quirks are kept on purpose too, each marked in the code with its source. A few of the enemy's tactics instructions do nothing, the torpedo search always starts from the same slot, and one random roll asks for a sound file the game never had, which plays as silence. Fixing them would make a battle play out differently from the original.

### How it was checked

The reference build of ScummVM records every random number a battle draws, and a snapshot of every ship, torpedo and camera every fifteen steps. The remake replays the same battle and compares every value exactly, not just closely.

- All 39 battles that include the Enterprise replay identically at Ensign and again at Lieutenant. So do four battles flown by hand, through flight, the console and self-destruct. Only one tiny difference had to be allowed for: one of the maths library's angle functions rounds differently in a browser.
- 82 recordings of real play replay identically.
- Screenshots of the remake, drawn the original's way, were compared with ScummVM's own screen: 211 of 228 match. The rest differ only by a few pixels of star overlap and smoothed edges.

With every assist off, a battle is the original's battle.

## What's new on screen

- **A 3D view of the original ships.** Every ship is the original model, with every vertex, face and part kept exactly. A test projects each of more than 600,000 points both ways and finds them within a ten-thousandth of a pixel. The ships are drawn with modern lighting and sharper textures, which are repainted where the repaint lines up with the original, and enlarged where it doesn't. Hits leave damage marks.
- **The effects:** phaser beams from each bank, torpedoes with a glow, shields that flash where they're hit, explosions and fading debris. A soft bloom lights only the beams, torpedoes and explosions. A cloaked ship shimmers as it decloaks.
- **Smooth motion.** The battle still steps fifteen times a second, but the ships and the camera glide between steps, so nothing judders on a 60 Hz or 120 Hz screen.
- **The backdrop.** A field of 1,500 stars drifts as the camera turns, and a soft nebula sits behind each battle. The original had no backdrop.
- **The tactical console** is repainted the same way as the other ship screens, and checked to line up with the original within 2 pixels.
- **A wide view.** It fills the window at your screen's shape, with a slim display of shields, hull, the target, the last log lines and the warning lamps. The original's split view, a box beside the console, is still there.
- **Sound.** The crew's voice cues, the weapons and the battle music are all the original's. A new **3D sound** setting places each sound to the left or right of the camera. Turn it off for the original mono mix.

## Assists

None of these is on unless you choose it, and all but Story leave the battle's numbers alone.

- **Combat difficulty:** As the game (the default), Ensign, Lieutenant, Captain or Story. It sets how hard battles are, separately from the game's own difficulty, and takes effect from the next battle.
- **Story** is for players who are here for the plot. Enemies do a quarter of the damage and hit half as often, and the battle runs on Ensign's rules, with Delegate on from the start. A lucky hit can still get through, so a battle can still be lost.
- **Pause** (P) stops the battle while the console stays live. Orders given while paused wait for the next step, so a paused battle plays out exactly as the same orders given live would.
- **Battle speed:** 1×, 2×, 4× or 8× (the full stop key cycles it).
- **Auto-resolve** fights the rest of the battle at once, with Delegate flying and nothing drawn, then shows the result and the ship's log. It's a real battle, so it can be lost.

The original's own Combat Options screen is still on F1. It covers stars, resolution, radar, detail and the sixteen keys, with a preview of the Enterprise. The game's Settings page has a Combat section with the same options.

## Controls

- **Keyboard:** the original's key map, unchanged. On top of it: W and S to pitch, Q and E to roll, Space to fire both weapons, P to pause and the full stop key for battle speed. Every flying and firing key can be rebound in Settings.
- **Mouse:** click a ship to target it, or click its blip on the radar. Hold and drag in the view to steer. The wheel zooms.
- **Touch:** play in landscape. On a short screen, combat opens in the wide view, with the console as a drawer along the bottom. Tap a ship or a blip to target it, drag to steer, and use the fire buttons on screen.
- **Gamepad:**
  - the left stick turns and climbs, the right stick rolls, and the triggers set the throttle;
  - A fires phasers, B fires torpedoes, and X brings the ship to a full stop;
  - the bumpers change target;
  - Start pauses.
- **Keyboard only:** F6 moves focus into the console's controls, and focus never gets stuck.

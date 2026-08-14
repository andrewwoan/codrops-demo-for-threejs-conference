# Audio credits

## Impact samples

`peg-*.mp3`, `wall-*.mp3`, `hit-*.mp3`, `drop.mp3`

From **Impact Sounds** by **Kenney** — <https://kenney.nl/assets/impact-sounds>

Licence: **CC0 1.0 Universal** (public domain dedication)
<https://creativecommons.org/publicdomain/zero/1.0/>

Free for personal, educational and commercial use. Attribution is not required
by the licence; it is given here anyway.

Source files used, re-encoded to mono 44.1 kHz MP3 @ 96 kbps. `drop.mp3` is
additionally softened: 5 ms fade-in on the attack, -9 dB shelf above 3.5 kHz,
low-pass at 7 kHz, loudness-normalised. The original `impactPlank_medium_000`
was tried first and was too harsh — it measured 23 dB brighter above 2 kHz than
anything else in the set.

`flip-a/b.mp3` get a 3 ms fade-in and a -5 dB shelf above 4.5 kHz.
`plunge.mp3` is pitched DOWN (0.82x sample rate) for body before filtering, so
the plunger reads as a deeper thunk than the flippers rather than the same
knock at a different volume.

Note the wood families are split so nothing doubles up: `impactWood_medium`
000/002/004 are wall thuds, 001/003 are the flipper swing.

| Shipped as | Original |
|---|---|
| `peg-a/b/c.mp3` | `impactWood_light_000/002/004.ogg` |
| `wall-a/b/c.mp3` | `impactWood_medium_000/002/004.ogg` |
| `hit-a/b.mp3` | `impactWood_heavy_001/003.ogg` |
| `flip-a/b.mp3` | `impactWood_medium_001/003.ogg` |
| `flip-return.mp3` | `impactSoft_medium_000.ogg` |
| `plunge.mp3` | `impactPlank_medium_002.ogg` |
| `drop.mp3` | `footstep_wood_000.ogg` |

## Rolling loop

`roll.mp3` — not a sample. Synthesised with ffmpeg as brown noise band-limited
to 48-300 Hz with a resonant bump at 120 Hz, because nothing in the pack loops
and the bed is pitch- and volume-modulated at runtime from the balls' actual
speed anyway. No third-party rights apply to it.

An earlier version used pink noise across 170-2400 Hz and read as air
conditioning rather than as rolling; a wooden ball is a low rumble, and energy
above roughly a kilohertz turns it into hiss.

## Playback

[howler.js](https://howlerjs.com/) — MIT.

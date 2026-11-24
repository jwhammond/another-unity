Mertens Station is a research outpost with thirteen rooms with art, and the mission with the most going on at once: a beam-down, a trapped woman, a cable that has to be dealt with, and a strange craft over the conduits.

## The look

Cool metal and screens. Every plate is the original background with its dithering removed, enlarged four times and repainted, with one exception worth noting: the displays in the last room carry a one-pixel grid that sits at the same frequency as the de-dithering filter, so screens are kept out of that step and the room needed the near-lossless encoding to pass its check. All thirteen rooms are repainted, none upscale-only.

## The cable

The second and third screens draw a cable that is not in the plate. The original stores it as sprites that are named like masks, so the first attempt to cut masks from the plate took pieces of the cable instead of leaving it as a layer. They are now their own cards. The cable that the player beams away is a layer that follows its object when the script moves it, with a sparkle and dissolve as it arrives. The cut cable beside the woman plays four animations as the transporter works on it.

## The beam effect

Nothing drew a transporter effect leaving the ship or arriving, so the team simply appeared. The effect is now the original's: one animation over the objects, then a second while they dissolve in a block pattern over seven steps. The second sheet in the sprites section is that effect, upscaled but not repainted.

## The phaser and the probe

The phaser's beam is a few pixels wide in the original and is drawn procedurally, from the muzzle of the firing direction to the target's aim point, rather than from a sprite. The probe over the sixth screen is a 30-frame alien craft that failed its alignment check once before a lower denoise and a new seed let it pass.

## The woman

After the medical kit she wakes and sits up. Her waking animation failed twice at a higher denoise and passed at a lower one, so she is the one character here whose cards were redone to get a sequence that holds still.

## The consoles

The transporter console and the core console's buttons are small animated layers: each button plays its lit animation, then returns.

## The cards

The first sheet gathers the world's own cards: the people of the station (the woman in three states, the doctor, the crew member), then the cable pieces and a few props.

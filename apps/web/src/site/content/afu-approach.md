Star Trek: A Final Unity is rebuilt scene by scene. The rule is that the game stays the game: every room, puzzle and conversation behaves as the original does, and only the picture is new.

## The data lift

A tool reads the original's files, with the help of ScummVM's Unity engine as a reference, and writes the game's content as plain data: worlds, rooms, objects, scripts and dialogue. The simulation runs on that data. The site carries the lifted data only in encrypted form. It unlocks in the player's browser from their own copy of the game, so the site never hands out the original's content.

## The art pipeline

Each room's background goes through the same recipe:

- The original's dithering is removed, then the picture is scaled up four times.
- A masked repaint redraws it in a modern style, while the parts that matter for play, such as screens, are protected.
- An alignment check requires the new picture to line up with the original within 2 px, so hotspots and walking stay where they were.
- A room that drifts is nudged back by a local warp, limited to 5 px at any point. Past that, the room is not forced: it keeps a plate that is only upscaled, with no repaint.

## Hotspots and sprite placement

The original draws crew, people, props and doors over every background. A checking tool compares each room's objects, their state and their position, in ScummVM and in our version, and lists the differences. Anything the repaint left out of the picture is flagged until a layer stands in for it.

## Layers, portraits and sound

Animated parts of a room are separate layers whose frames are streamed in as they are needed. Conversations show the speaker as a small portrait in the subtitle box. Sound and music are the original's, transcoded for the browser, and the painted buttons on each ship screen were audited one by one against what our interface offers.

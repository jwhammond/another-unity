// SPDX-License-Identifier: GPL-3.0-or-later
import { useEffect, useRef, useState } from 'preact/hooks';
import type { Rect } from '../../view/art';
import { layoutChoices, type Rect as Corners } from '../../view/dialogLayout';
import { drawHolodeck, HOLODECK_CANCEL, type LoadedHolodeckArt } from '../../view/holodeckArt';
import { IndexedScreen, SCREEN_H, SCREEN_W } from '../../view/indexed';
import type { ShipPort } from '../../web/shipPort';
import { areaStyle } from './areas';
import { useAttempt, usePort } from './hooks';

type Movies = { stem: string; title: string }[];

const rectOf = (c: Corners): Rect => [c[0], c[1], c[2] - c[0], c[3] - c[1]];

/**
 * The holodeck (UnityEngine::runHolodeck, unity.cpp:379-426): the movies seen so far, to see again, and the Bridge button that leaves. With the
 * original's pictures published (`art holodeck publish`) it is holodeck.rm with the original's choice dialog over it (dialog.mrg's frame, fonts 2
 * and 3, the round scroll buttons), drawn onto a canvas with clear controls over the choices, the scroll buttons and the Bridge button painted on
 * the picture; without them, a plain panel. A movie plays through the ordinary movie dialog.
 */
export function HolodeckPanel({ port }: { port: ShipPort }) {
  usePort(port);
  const view = port.holodeck();
  if (view === null) return null;
  const art = port.holodeckArt();
  return art ? <ArtHolodeck port={port} movies={view.movies} art={art} /> : <PlainHolodeck port={port} movies={view.movies} />;
}

function ArtHolodeck({ port, movies, art }: { port: ShipPort; movies: Movies; art: LoadedHolodeckArt }) {
  const [problem, attempt] = useAttempt();
  // (how many lines the choices are scrolled, and the one pointed at or focused: runChoice's _dialogStartLine and _dialogSelected)
  const [start, setStart] = useState(0);
  const [selected, setSelected] = useState(-1);
  const canvas = useRef<HTMLCanvasElement>(null);
  const screen = useRef(new IndexedScreen(SCREEN_W, SCREEN_H));
  const titles = movies.map(m => m.title);
  const layout = layoutChoices(art, titles, start);
  const drawn = `${titles.join('\n')}|${start}|${selected}`;
  useEffect(() => {
    drawHolodeck(screen.current, art, titles, start, selected);
    const context = canvas.current?.getContext('2d') ?? null;
    if (!context || !canvas.current) return;
    const image = context.createImageData(SCREEN_W, SCREEN_H);
    screen.current.toRgba(art.palette, image.data);
    context.putImageData(image, 0, 0);
    canvas.current.dataset.drawn = drawn;
  }, [art, drawn]);
  const scroll = (by: -1 | 1) => { if (by === -1 ? start > 0 : layout.moreBelow) setStart(start + by); };
  return (
    <div class="au-eng au-holo" data-holodeck role="region" aria-label="Holodeck">
      <div class="au-ship-screen au-eng-screen" style={{ aspectRatio: `${SCREEN_W} / ${SCREEN_H}` }} onPointerLeave={() => setSelected(-1)}>
        <h2 class="au-visually-hidden">Holodeck</h2>
        <canvas ref={canvas} class="au-eng-canvas" width={SCREEN_W} height={SCREEN_H} aria-hidden="true" />
        {movies.length === 0 && <p class="au-visually-hidden">Nothing has been seen yet.</p>}
        <ul class="au-holo-movies" aria-label="Movies">
          {layout.rects.map((r, i) => {
            const m = movies[i];
            if (!m || r[2] === 0) return null;
            return (
              <li key={m.stem} style={areaStyle(rectOf(r))}>
                <button
                  type="button" class="au-holo-choice" data-movie={m.stem} data-selected={selected === i ? '' : undefined} aria-label={m.title}
                  onPointerEnter={() => setSelected(i)} onFocus={() => setSelected(i)} onBlur={() => setSelected(-1)}
                  onClick={() => attempt(() => port.holodeckPlay(m.stem))}
                >{m.title}</button>
              </li>
            );
          })}
        </ul>
        <button type="button" class="au-holo-scroll" data-scroll="up" aria-label="Scroll up" disabled={start === 0} style={areaStyle(rectOf(layout.up))} onClick={() => scroll(-1)} />
        <button type="button" class="au-holo-scroll" data-scroll="down" aria-label="Scroll down" disabled={!layout.moreBelow} style={areaStyle(rectOf(layout.down))} onClick={() => scroll(1)} />
        {/* (the Bridge button is painted on holodeck.rm: runChoice's cancel rectangle, 484 by 426 to 605 by 468) */}
        <span class="au-painted" data-area="painted-bridge" style={areaStyle(rectOf(HOLODECK_CANCEL))}>
          <button type="button" class="au-painted-btn" data-painted="bridge" data-holodeck-bridge aria-label="Bridge" onClick={() => attempt(() => port.holodeckLeave())}>Bridge</button>
        </span>
        {problem !== null && <p class="au-problem au-holo-problem" role="alert">{problem}</p>}
      </div>
    </div>
  );
}

/** Without the original's pictures: the movies as a list of buttons, and Bridge. */
function PlainHolodeck({ port, movies }: { port: ShipPort; movies: Movies }) {
  const [problem, attempt] = useAttempt();
  return (
    <div class="au-ship-holodeck" data-holodeck>
      <h2>Holodeck</h2>
      {movies.length === 0 && <p>Nothing has been seen yet.</p>}
      <ul class="au-ship-movies" aria-label="Movies">
        {movies.map(m => (
          <li key={m.stem}><button type="button" data-movie={m.stem} onClick={() => attempt(() => port.holodeckPlay(m.stem))}>{m.title}</button></li>
        ))}
      </ul>
      <button type="button" data-holodeck-bridge onClick={() => attempt(() => port.holodeckLeave())}>Bridge</button>
      {problem !== null && <p class="au-problem" role="alert">{problem}</p>}
    </div>
  );
}

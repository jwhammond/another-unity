/* ScummVM - Graphic Adventure Engine
 *
 * ScummVM is the legal property of its developers, whose names
 * are too numerous to list here. Please refer to the COPYRIGHT
 * file distributed with this source distribution.
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.

 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU General Public License for more details.

 * You should have received a copy of the GNU General Public License
 * along with this program.  If not, see <http://www.gnu.org/licenses/>.
 *
 */

// LOCAL TEST HARNESS - never commit. Included inside UnityConsole::runPendingCommand().
// unity_script=<file> in the config: one step per line:
//   wait <ms> | shot <png> | click x y | rclick x y | move x y | quit | <console command>
{
	static Common::StringArray &hLines = *new Common::StringArray(); // leaked: must outlive OSystem
	static uint hLine = 0;
	static uint32 hWaitUntil = 0;
	static bool hLoaded = false;
	// the scripted inputs for the next fight: at <step> <combat line>
	static Common::Array<uint> &hAtSteps = *new Common::Array<uint>();
	static Common::StringArray &hAtLines = *new Common::StringArray();
	static uint hAtNext = 0;
	// whether the fight has found its battle (one that hadn't left when the fight began), and whether it is
	// applying an input, so a nested hook (an input's conversation) only clicks through
	static bool hFightBegun = false;
	static bool hInFight = false;
	if (!hLoaded) {
		hLoaded = true;
		Common::String path = ConfMan.get("unity_script");
		if (!path.empty()) {
			Common::FSNode node(Common::Path(path, Common::Path::kNativeSeparator));
			Common::SeekableReadStream *f = node.createReadStream();
			while (f && !f->eos()) {
				Common::String l = f->readLine();
				l.trim();
				if (!l.empty() && l[0] != '#')
					hLines.push_back(l);
			}
			delete f;
		}
	}
	// keys go through the keymapper as real ones do (if the hook included keymapper.h)
	auto pushKey = [](const Common::Event &ev) {
#ifdef COMMON_KEYMAPPER_H
		Common::List<Common::Event> mapped;
		if (g_system->getEventManager()->getKeymapper()->mapEvent(ev, mapped)) {
			for (Common::List<Common::Event>::iterator i = mapped.begin(); i != mapped.end(); ++i)
				g_system->getEventManager()->pushEvent(*i);
			return;
		}
#endif
		g_system->getEventManager()->pushEvent(ev);
	};
	while (_pending == kPendingNone && hLine < hLines.size() && g_system->getMillis() >= hWaitUntil) {
		Common::String l = hLines[hLine++];
		debug("HARNESS> %s", l.c_str());
		Common::StringArray a;
		Common::StringTokenizer tok(l, " ");
		while (!tok.empty())
			a.push_back(tok.nextToken());
		const char *argv[16];
		int argc = MIN<int>(a.size(), 16);
		for (int i = 0; i < argc; i++)
			argv[i] = a[i].c_str();
		Common::String c = a[0];
		if (c == "wait") {
			hWaitUntil = g_system->getMillis() + atoi(argv[1]);
		} else if (c == "shot") {
			::Graphics::Surface *s = g_system->lockScreen();
			byte pal[256 * 3];
			if (s->format.bytesPerPixel == 1)
				g_system->getPaletteManager()->grabPalette(pal, 0, 256);
			Common::DumpFile out;
			if (out.open(Common::Path(argv[1], Common::Path::kNativeSeparator)))
				::Image::writePNG(out, *s, s->format.bytesPerPixel == 1 ? pal : nullptr);
			g_system->unlockScreen();
		} else if (c == "down" || c == "up") {
			Common::Event ev;
			ev.mouse = Common::Point(atoi(argv[1]), atoi(argv[2]));
			g_system->warpMouse(ev.mouse.x, ev.mouse.y);
			ev.type = Common::EVENT_MOUSEMOVE;
			g_system->getEventManager()->pushEvent(ev);
			ev.type = (c == "down") ? Common::EVENT_LBUTTONDOWN : Common::EVENT_LBUTTONUP;
			g_system->getEventManager()->pushEvent(ev);
			hWaitUntil = g_system->getMillis() + 200;
		} else if (c == "key") {
			Common::Event ev;
			ev.type = Common::EVENT_KEYDOWN;
			char k = (argc < 2) ? 0 : (!strcmp(argv[1], "space") ? ' ' : argv[1][0]);
			ev.kbd = Common::KeyState((Common::KeyCode)k, k);
			pushKey(ev);
			ev.type = Common::EVENT_KEYUP;
			pushKey(ev);
			hWaitUntil = g_system->getMillis() + 200;
		} else if (c == "keydown" || c == "keyup") {
			// named keys, held: keydown up ... keyup up
			static const struct { const char *name; Common::KeyCode code; } kNamed[] = {
				{ "up", Common::KEYCODE_UP }, { "down", Common::KEYCODE_DOWN }, { "left", Common::KEYCODE_LEFT },
				{ "right", Common::KEYCODE_RIGHT }, { "home", Common::KEYCODE_HOME }, { "pageup", Common::KEYCODE_PAGEUP },
				{ "pagedown", Common::KEYCODE_PAGEDOWN }, { "end", Common::KEYCODE_END }, { "plus", Common::KEYCODE_KP_PLUS },
				{ "minus", Common::KEYCODE_KP_MINUS }, { "enter", Common::KEYCODE_RETURN }, { "del", Common::KEYCODE_DELETE },
				{ "ins", Common::KEYCODE_INSERT }, { "tab", Common::KEYCODE_TAB }, { "esc", Common::KEYCODE_ESCAPE },
				{ "backspace", Common::KEYCODE_BACKSPACE }, { "f1", Common::KEYCODE_F1 }, { "lshift", Common::KEYCODE_LSHIFT }
			};
			// (S+ holds shift: keydown S+tab)
			const char *name = argv[1];
			byte flags = 0;
			if (!strncmp(name, "S+", 2) && name[2]) {
				flags = Common::KBD_SHIFT;
				name += 2;
			}
			Common::KeyCode code = (Common::KeyCode)name[0];
			for (uint i = 0; i < ARRAYSIZE(kNamed); i++)
				if (!strcmp(name, kNamed[i].name))
					code = kNamed[i].code;
			Common::Event ev;
			ev.type = (c == "keydown") ? Common::EVENT_KEYDOWN : Common::EVENT_KEYUP;
			ev.kbd = Common::KeyState(code, 0, flags);
			pushKey(ev);
			hWaitUntil = g_system->getMillis() + 50;
		} else if ((c == "save" && !_vm->canSaveGameStateCurrently()) || (c == "load" && !_vm->canLoadGameStateCurrently())) {
			// (wait until the game allows it, as the menu would)
			debug("HARNESS waiting: dialog %d depth %d change %d walk %d delayed %d beams %d combat %d away %d member %p type %d",
				_vm->_in_dialog, _vm->_actionDepth, _vm->_screenChangePending, _vm->_walkQueue.size(), _vm->_delayedActions.size(),
				_vm->_beamEffects.size(), 0, _vm->_on_away_team,
				(void *)_vm->_current_away_team_member, _vm->_currScreenType);
			hLine--;
			hWaitUntil = g_system->getMillis() + 200;
			break;
		} else if (c == "save") {
			Common::Error e = _vm->saveGameState(atoi(argv[1]), argc > 2 ? argv[2] : "harness");
			debug("HARNESS save %d: %d", atoi(argv[1]), e.getCode());
		} else if (c == "load") {
			Common::Error e = _vm->loadGameState(atoi(argv[1]));
			debug("HARNESS load %d: %d", atoi(argv[1]), e.getCode());
		} else if (c == "settle") {
			// click through whatever's being said
			if (_vm->_in_dialog && !_vm->_dialog_choosing) {
				Common::Event click;
				click.mouse = Common::Point(320, 400);
				click.type = Common::EVENT_LBUTTONDOWN;
				g_system->getEventManager()->pushEvent(click);
				click.type = Common::EVENT_LBUTTONUP;
				g_system->getEventManager()->pushEvent(click);
				hLine--;
				hWaitUntil = g_system->getMillis() + 600;
				break;
			}
			hWaitUntil = g_system->getMillis() + 500;
		} else if (c == "choose") {
			// choose <text>: the choice containing the text, once a choice is up
			Common::String want = l.substr(7);
			int found = -1;
			if (_vm->_in_dialog && _vm->_dialog_choosing && !_vm->_dialogRects.empty()) {
				Common::String lowWant = want;
				lowWant.toLowercase();
				for (uint i = 0; i < _vm->_choice_list.size() && found == -1; i++) {
					Common::String choice = _vm->_choice_list[i];
					choice.toLowercase();
					if (choice.contains(lowWant))
						found = i;
				}
				if (found == -1) {
					static uint32 hListed = 0;
					if (g_system->getMillis() > hListed) {
						hListed = g_system->getMillis() + 5000;
						for (uint i = 0; i < _vm->_choice_list.size(); i++)
							debug("HARNESS option %d: %s", i, _vm->_choice_list[i].c_str());
					}
				}
			}
			if (found == -1) {
				// (clicking through what's said until then)
				if (_vm->_in_dialog && !_vm->_dialog_choosing) {
					Common::Event click;
					click.mouse = Common::Point(320, 400);
					click.type = Common::EVENT_LBUTTONDOWN;
					g_system->getEventManager()->pushEvent(click);
					click.type = Common::EVENT_LBUTTONUP;
					g_system->getEventManager()->pushEvent(click);
				}
				hLine--;
				hWaitUntil = g_system->getMillis() + 600;
				break;
			}
			if ((uint)found >= _vm->_dialogRects.size() || _vm->_dialogRects[found].isEmpty()) {
				// (scrolled out of sight)
				bool down = (uint)found >= _vm->_dialogRects.size();
				Common::Rect button = down ? _vm->_dialogDownRect : _vm->_dialogUpRect;
				Common::Event click;
				click.mouse = Common::Point(button.left + button.width() / 2, button.top + button.height() / 2);
				click.type = Common::EVENT_LBUTTONDOWN;
				g_system->getEventManager()->pushEvent(click);
				click.type = Common::EVENT_LBUTTONUP;
				g_system->getEventManager()->pushEvent(click);
				hLine--;
				hWaitUntil = g_system->getMillis() + 300;
				break;
			}
			Common::Point at = _vm->_dialogRects[found].origin();
			at.x += 10;
			at.y += 4;
			debug("HARNESS chose %d: %s", found, _vm->_choice_list[found].c_str());
			Common::Event ev;
			ev.mouse = at;
			g_system->warpMouse(at.x, at.y);
			ev.type = Common::EVENT_MOUSEMOVE;
			g_system->getEventManager()->pushEvent(ev);
			ev.type = Common::EVENT_LBUTTONDOWN;
			g_system->getEventManager()->pushEvent(ev);
			ev.type = Common::EVENT_LBUTTONUP;
			g_system->getEventManager()->pushEvent(ev);
			hWaitUntil = g_system->getMillis() + 300;
		} else if (c == "ship") {
			// ship <code> [battle screen]
			if (argc > 2)
				_vm->_battleScenario = strtol(argv[2], nullptr, 0);
			_vm->gotoShipScreen(strtol(argv[1], nullptr, 0));
		} else if (c == "damage") {
			objectID oid; parseObjectID(argv[1], oid);
			_vm->damageObject(_vm->data.getObject(oid), atoi(argv[2]));
		} else if (c == "phasertest") {
			for (uint i = 0; i < _vm->data._phaserableObjects.size(); i++) {
				uint32 v = _vm->data._phaserableObjects[i];
				objectID oid(v & 0xff, (v >> 8) & 0xff, (v >> 16) & 0xff);
				if (!objectExists(oid)) { debug("HARNESS phasertest: no object %06x", v); continue; }
				Object *o = _vm->data.getObject(oid);
				debug("HARNESS phasertest %06x: %s", v, o->phaser_data ? Common::String::format("health %d thr %d dmg %d gtp %d/%d lists %d/%d/%d", o->phaser_data->health, o->phaser_data->threshold, o->phaser_data->damage_setting, o->phaser_data->gtp_setting, o->phaser_data->gtp_min_setting, o->phaser_data->stun_entries.list.size(), o->phaser_data->gtp_entries.list.size(), o->phaser_data->kill_entries.list.size()).c_str() : "none");
			}
		} else if (c == "trigdump") {
			for (uint i = 0; i < _vm->data._triggers.size(); i++) {
				Trigger *t = _vm->data._triggers[i];
				if (argc > 1 && t->id != strtoul(argv[1], nullptr, 16))
					continue;
				debug("HARNESS trig %x type %d en %d ctx %d dist %d from %02x%02x%02x to %02x%02x%02x rev %d inst %d timer %d", t->id, t->type,
					t->enabled, t->context, t->dist, t->from.world, t->from.screen, t->from.id, t->to.world, t->to.screen, t->to.id, t->reversed, t->instant, t->timer_start);
			}
		} else if (c == "pause") {
			// paused and resumed, as ScummVM's menu does
			PauseToken pause = _vm->pauseEngine();
			pause.clear();
		} else if (c == "status") {
			debug("HARNESS status: '%s' mode %d member %s held %s", _vm->_status_text.c_str(), _vm->_mode,
				_vm->_current_away_team_member ? _vm->_current_away_team_member->name.c_str() : "-",
				_vm->_held_item ? _vm->_held_item->name.c_str() : "-");
		} else if (c == "click" || c == "rclick" || c == "move") {
			Common::Event ev;
			ev.mouse = Common::Point(atoi(argv[1]), atoi(argv[2]));
			g_system->warpMouse(ev.mouse.x, ev.mouse.y);
			ev.type = Common::EVENT_MOUSEMOVE;
			g_system->getEventManager()->pushEvent(ev);
			if (c != "move") {
				ev.type = (c == "click") ? Common::EVENT_LBUTTONDOWN : Common::EVENT_RBUTTONDOWN;
				g_system->getEventManager()->pushEvent(ev);
				ev.type = (c == "click") ? Common::EVENT_LBUTTONUP : Common::EVENT_RBUTTONUP;
				g_system->getEventManager()->pushEvent(ev);
			}
			hWaitUntil = g_system->getMillis() + 200;
		} else if (c == "activate") {
			// activate <wwssii> <0|1>: an object's OBJFLAG_ACTIVE, as the story's scripts set it (a battle's Enterprise)
			objectID oid; parseObjectID(argv[1], oid);
			Object *o = _vm->data.getObject(oid);
			if (atoi(argv[2]))
				o->flags |= OBJFLAG_ACTIVE;
			else
				o->flags &= ~OBJFLAG_ACTIVE;
		} else if (c == "difficulty") {
			// difficulty <0-2>: as the options would set it (UnityEngine::difficulty)
			ConfMan.setInt("difficulty", atoi(argv[1]));
		} else if (c == "at") {
			// at <step> <combat line>: an input for the next fight, once the battle has taken that many steps
			uint skip = 3 + a[1].size() + 1;
			hAtSteps.push_back(atoi(argv[1]));
			hAtLines.push_back(l.substr(skip));
		} else if (c == "fight") {
			// fight <cap>: the battle plays on, the at lines applied at their steps, until it leaves the
			// tactical screen, only the Enterprise is left, or <cap> steps (docs/trace-format.md, "Space combat")
			// (the script stays on this line until the fight ends, so a hook nested in the fight, such as an input's
			// conversation, comes back here rather than running the lines after it)
			hLine--;
			if (!CombatTrace::tracing()) {
				warning("HARNESS: fight needs a running trace (trace <file> <seed> before it): the run stops");
				_vm->quitGame();
				hLine = hLines.size();
				break;
			}
			TacticalScreen *tactical = _vm->_tacticalScreen;
			// (a battle that left before this fight, without one, isn't this fight's: wait for the next to start)
			if (!hFightBegun && (!CombatTrace::inBattle() || CombatTrace::left())) {
				hWaitUntil = g_system->getMillis() + 50;
				break;
			}
			hFightBegun = true;
			// (a battle that has left ends the fight at once, whatever the leave led to: the game's end runs nested in
			// the leave, tactical.cpp:373-379 and unity.cpp:343-344, as the Admiral's conversation and then a menu,
			// unity.cpp:488-535, whose first choice, clicked through as a hail's would be, opens the load dialog, which
			// no hook reaches)
			bool over = CombatTrace::left() || !tactical->inCombat();
			// (a hail's conversation, from the middle of the battle or from an input: its lines clicked through and
			// its first choice taken, as the trace's replay takes what processHails left, not the conversation)
			if (!over && _vm->_in_dialog) {
				Common::Event click;
				click.mouse = Common::Point(320, 400);
				if (_vm->_dialog_choosing && !_vm->_dialogRects.empty() && !_vm->_dialogRects[0].isEmpty())
					click.mouse = Common::Point(_vm->_dialogRects[0].left + 10, _vm->_dialogRects[0].top + 4);
				g_system->warpMouse(click.mouse.x, click.mouse.y);
				click.type = Common::EVENT_MOUSEMOVE;
				g_system->getEventManager()->pushEvent(click);
				click.type = Common::EVENT_LBUTTONDOWN;
				g_system->getEventManager()->pushEvent(click);
				click.type = Common::EVENT_LBUTTONUP;
				g_system->getEventManager()->pushEvent(click);
				hWaitUntil = g_system->getMillis() + 300;
				break;
			}
			// (only at the top of a frame, between steps: not from a hook nested in a step, such as the warp
			// overlay's wait, ai.cpp:246, or a line of a hook's conversation once clicked, nor in an input)
			if (!over && (CombatTrace::inStep() || hInFight)) {
				hWaitUntil = g_system->getMillis() + 50;
				break;
			}
			Combat *combat = tactical->_combat;
			uint step = CombatTrace::step();
			const char *reason = nullptr;
			if (over)
				reason = "leave";
			else if (combat->liveShips() < 2)
				reason = "won";
			else if (step >= (uint)atoi(argv[1]))
				reason = "cap";
			hInFight = true;
			while (!reason && hAtNext < hAtSteps.size() && hAtSteps[hAtNext] <= step) {
				Common::String line = hAtLines[hAtNext++];
				// at <step> shot <png>: the screen as it is (the frame drawn after the step before this one: the hook comes
				// before drawScene, unity.cpp:1834-1836), and the step, for tools/combatshots; not an input, so not traced
				if (line.hasPrefix("shot ")) {
					::Graphics::Surface *shot = g_system->lockScreen();
					byte shotPal[256 * 3];
					if (shot->format.bytesPerPixel == 1)
						g_system->getPaletteManager()->grabPalette(shotPal, 0, 256);
					Common::DumpFile shotOut;
					if (shotOut.open(Common::Path(line.c_str() + 5, Common::Path::kNativeSeparator)))
						::Image::writePNG(shotOut, *shot, shot->format.bytesPerPixel == 1 ? shotPal : nullptr);
					g_system->unlockScreen();
					debug("HARNESS shot %s at step %u", line.c_str() + 5, step);
					continue;
				}
				Common::StringArray w;
				Common::StringTokenizer t(line, " ");
				while (!t.empty())
					w.push_back(t.nextToken());
				CombatShip *enterprise = combat->enterprise();
				bool ok = true;
				const Common::String &v = w[0];
				auto on = [&](uint i) { return w.size() > i && w[i] == "on"; };
				auto held = [&](uint i, int less, int more) {
					int d = w.size() > i ? atoi(w[i].c_str()) : 0;
					return d < 0 ? 1u << less : d > 0 ? 1u << more : 0u;
				};
				if (v == "steer" && w.size() == 5) {
					// (TacticalScreen::actionStart and actionEnd, tactical.cpp:731-737: the flight keys as bits)
					const uint32 orbit = (1u << kFlightOrbitLeft) | (1u << kFlightOrbitRight);
					tactical->_held = (tactical->_held & orbit) | held(2, kFlightPitchDown, kFlightPitchUp) |
						held(3, kFlightRollLeft, kFlightRollRight) | held(1, kFlightYawLeft, kFlightYawRight) |
						held(4, kFlightDecelerate, kFlightAccelerate);
				} else if (v == "orbit" && w.size() == 2) {
					const uint32 orbit = (1u << kFlightOrbitLeft) | (1u << kFlightOrbitRight);
					tactical->_held = (tactical->_held & ~orbit) | held(1, kFlightOrbitLeft, kFlightOrbitRight);
				} else if (v == "stop") {
					combat->stop();
					_vm->_cues->play(0xa);
				} else if (v == "fire" && w.size() == 2) {
					if (w[1] != "torpedoes")
						combat->firePhasers(enterprise);
					if (w[1] != "phasers")
						combat->fireTorpedoes(enterprise, 0);
				} else if (v == "target" && w.size() == 2) {
					if (w[1] == "next" || w[1] == "prev")
						combat->nextTarget(w[1] == "next" ? 1 : -1);
					else if (w[1] == "none")
						combat->setTarget(nullptr);
					else if ((uint)atoi(w[1].c_str()) < combat->_ships.size())
						combat->setTarget(combat->_ships[atoi(w[1].c_str())]);
				} else if (v == "delegate" && w.size() == 2) {
					combat->setDelegate(on(1), true);
				} else if (v == "maneuver" && w.size() == 2) {
					// (the Tactics page's seven rows, tactical.cpp:668-673)
					if ((uint)atoi(w[1].c_str()) < 7)
						combat->clickManeuver(atoi(w[1].c_str()));
				} else if (v == "scroll" && w.size() == 2) {
					combat->scrollManeuvers(w[1] == "up" ? -1 : 1);
				} else if (v == "engage") {
					combat->engageManeuver();
				} else if (v == "hail") {
					tactical->hail();
				} else if (v == "bridge" || v == "engineering") {
					// (the buttons' actions, without their delay: kButtonBridge 0, kButtonEngineering 1)
					tactical->buttonAction(v == "bridge" ? 0 : 1);
				} else if (v == "view" && w.size() == 3) {
					combat->setView(w[2] == "target" ? combat->target() : enterprise, atoi(w[1].c_str()));
				} else if (v == "cycle") {
					combat->cycleView();
				} else if (v == "zoom" && w.size() == 2) {
					if (w[1] == "in")
						combat->zoomIn();
					else
						combat->zoomOut();
				} else if (v == "wide" && w.size() == 2) {
					tactical->setWide(on(1));
				} else if (v == "page" && w.size() == 2) {
					// (the console's tabs, in the original's order: tactical.cpp:57-60, 184, 228-229; mouseClick, 655-658)
					static const char *const kPages[] = { "phasers", "torpedoes", "damage", "conn", "tactics", "sensors" };
					ok = false;
					for (uint i = 0; i < ARRAYSIZE(kPages); i++) {
						if (w[1] == kPages[i]) {
							tactical->_page = i;
							ok = true;
						}
					}
				} else if (v == "set" && w.size() >= 2) {
					// the console's pages (TacticalScreen::pressButton, dragSlider, mouseClick: tactical.cpp:523-574, 618-631, 661-667)
					const Common::String &k = w[1];
					int n = w.size() > 2 ? atoi(w[2].c_str()) : 0;
					if (k == "banks" && w.size() == 3) {
						for (uint i = 0; enterprise && i < enterprise->banks.size(); i++)
							enterprise->banks[i].setting = w[2] == "all" ? 100 : 0;
					} else if (k == "bank" && w.size() == 4) {
						if (enterprise && (uint)n < enterprise->banks.size())
							enterprise->banks[n].setting = CLIP(atoi(w[3].c_str()), 0, 100);
					} else if (k == "salvo" && w.size() == 4 && (n == 0 || n == 1)) {
						combat->_salvo[n].setting = CLIP(atoi(w[3].c_str()), 0, 10);
					} else if (k == "spread" && w.size() == 3 && n >= 0 && n < 10) {
						combat->setSpread(n);
					} else if (k == "shields" && w.size() == 3) {
						combat->raiseShields(on(2));
					} else if (k == "lock" && w.size() == 3) {
						combat->setWeaponsLock(on(2));
					} else if (k == "power" && w.size() == 3 && n >= 0 && n < 5) {
						combat->setPowerLevel(n);
					} else if (k == "selfdestruct" && w.size() == 2) {
						combat->armSelfDestruct();
					} else {
						ok = false;
					}
				} else {
					ok = false;
				}
				if (ok)
					CombatTrace::input(combat, line.c_str());
				else
					debug("HARNESS: bad combat line: %s", line.c_str());
			}
			hInFight = false;
			if (reason) {
				CombatTrace::end(combat, reason);
				hAtSteps.clear();
				hAtLines.clear();
				hAtNext = 0;
				hFightBegun = false;
				hLine++;
			} else {
				// (once a frame: the next step comes with the next update)
				break;
			}
		} else if (c == "quit") {
			_vm->quitGame();
		} else if (c == "screen") { cmdScreen(argc, argv);
		} else if (c == "bridge") { cmdBridge(argc, argv);
		} else if (c == "computer") { cmdComputer(argc, argv);
		} else if (c == "objects") { cmdObjects(argc, argv);
		} else if (c == "object") { cmdObject(argc, argv);
		} else if (c == "action") { cmdAction(argc, argv);
		} else if (c == "trigger") { cmdTrigger(argc, argv);
		} else if (c == "conv") { cmdConversation(argc, argv);
		} else if (c == "movie") { cmdMovie(argc, argv);
		} else if (c == "anim") { cmdAnim(argc, argv);
		} else if (c == "polys") { cmdPolygons(argc, argv);
		} else if (c == "scriptcheck") { cmdScriptCheck(argc, argv);
		} else if (c == "beam") { cmdBeam(argc, argv);
		} else if (c == "warp") { cmdWarp(argc, argv);
		} else if (c == "combat") { cmdCombat(argc, argv);
		} else if (c == "gameend") { _vm->gotoShipScreen(0xfe | (atoi(argv[1]) << 8));
		} else {
			bool keepRunning;
			if (!handleCommand(argc, argv, keepRunning))
				debug("HARNESS: unknown step");
		}
		if (_pending != kPendingNone)
			break;
	}
}

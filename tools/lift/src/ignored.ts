// SPDX-License-Identifier: GPL-3.0-or-later
import { SPACE_EXT } from './space/files';
import { fieldPaths } from './track';

const UI = 'UI only (Plan 5)';
const TRANSPORTER = "the transporter room (Plan 6's bridge stub)";

/** IR fields the lifter deliberately doesn't carry over, and why. Everything under a listed field is covered too. */
export const IGNORED: Readonly<Record<string, string>> = {
  'manifest.format': "checked by readRaw (rawcheck's Manifest schema)",
  'manifest.version': "checked by readRaw (rawcheck's Manifest schema)",
  'manifest.generator': 'a label',
  'manifest.worlds': 'ids duplicated by the files read; the lifter iterates the files',
  'manifest.files': 'read by readRaw and checked file by file by losslessCheck',

  'object.z': 'unused by the away team (raw-ir.md, objects)',
  'object.anim_index': 'the sprite animation it starts with: presentation (Plan 5)',
  'object.region_id': 'unused by the away-team code (raw-ir.md, objects)',
  'object.use_verb': "the UI's wording for using it (Plan 5)",
  'object.use_preposition': "the UI's wording for using it (Plan 5)",
  'object.cursor_id': UI,
  'object.cursor_flag': UI,

  'entry:ConditionBlock._order': 'a condition always runs first (sortLastEntry, object.cpp:319-333)',
  'entry:ConditionBlock._stopHere': 'always 0: ConditionBlock::readFrom clears it (object.cpp:356-358)',
  'entry:ConditionBlock.check_unknown': "the z coordinate, which ConditionBlock::check doesn't compare",
  'entry:AlterBlock.y_adjust': 'draw depth (and the new z): presentation',
  'entry:AlterBlock.cursor_id': UI,
  'entry:AlterBlock.cursor_flag': UI,
  'entry:ReactionBlock.dest_unknown': 'never read by ReactionBlock::execute',
  'entry:BeamBlock.unknown1': 'never read by BeamBlock::execute',
  'entry:BeamBlock.unknown3': 'never read by BeamBlock::execute',
  'entry:ChoiceBlock._boxX': "the message box's place: UI",
  'entry:ChoiceBlock._boxY': "the message box's place: UI",
  'entry:ChoiceBlock._object': "the message box's icon: UI",

  'screen.location.polygons': "the polygon file's name; its contents are the screen's polygons",

  'maps.movie.file': 'a label',
  'maps.sprite.file': 'a label',
  'executable.file': 'a label',
  'executable._shipUnits[].paletteIndex': "the engineering panel's drawing: UI",
  'executable._enemyShip[].paletteIndex': "the engineering panel's drawing: UI",
  'combat.file': 'a label',
  'executable._failHailEntries': 'hails from the ship (sub-project 4)',
  'executable._actionStrings': UI,
  'executable._phaserMuzzles': 'where a phaser beam is drawn from: presentation (Plan 5)',
  'executable._transporterSpriteNames': TRANSPORTER,
  'executable._arrowCursor': UI,
  'executable._encounterThresholds': 'encounters and hazard damage: after M4 (spec §7)',
  'executable._hazardDamage': 'encounters and hazard damage: after M4 (spec §7)',
  'executable._hazardVoices': 'encounters and hazard damage: after M4 (spec §7)',
};

/** Export files the lifter doesn't read, and why. */
export const IGNORED_FILES: ReadonlyArray<readonly [RegExp, string]> = [
  [/^maps\/phaser\.json$/, "phaser.map's list: each object's own phaser_data carries the same data"],
  [/^maps\/icon\.json$/, 'inventory and portrait icons: UI (Plan 5)'],
  [/^verbatim\//, 'the other verbatim files, which no lift reads (Plan 3 Decision 15): later sub-projects'],
];

/** The export files the lifter reads. */
const READ_FILES = [
  /^manifest\.json$/, /^objects\//, /^conversations\//, /^screens\//, /^worlds\//,
  /^triggers\.json$/, /^maps\/movie\.json$/, /^maps\/sprite\.json$/, /^executable\.json$/, /^verbatim\/computer\.db$/, /^verbatim\/compstat$/,
  /^verbatim\/astro\.db$/, /^verbatim\/sector\.ast$/, /^ast_stat\.json$/, /^verbatim\/t_[0-9a-f]{4}00\.bst$/,
  /^combat\.json$/, /^trig\.json$/, new RegExp(`^verbatim/[^/]+\\.(?:bin|${SPACE_EXT})$`),
];

/** A field is ignored if it, or a field it is under, is in IGNORED. */
export function isIgnored(path: string): boolean {
  for (let p = path; ; ) {
    if (IGNORED[p] !== undefined) return true;
    const up = p.replace(/(\.[^.[\]]*|\[\])$/, '');
    if (up === p) return false;
    p = up;
  }
}

export interface ScopeValue {
  value: unknown;
  root: string;
  /** Fields whose contents aren't in scope (a stub object's rule lists). */
  skip?: ReadonlySet<string>;
}

export interface LosslessResult {
  problems: string[];
  consumed: number;
  ignored: number;
  total: number;
}

/** Every field kind in scope must have been read or be ignored; every file must be read or ignored. */
export function losslessCheck(used: ReadonlySet<string>, scope: ScopeValue[], files: string[]): LosslessResult {
  const present = new Set<string>();
  for (const s of scope) fieldPaths(s.value, s.root, present, s.skip);
  const result: LosslessResult = { problems: [], consumed: 0, ignored: 0, total: present.size };
  for (const path of [...present].sort()) {
    if (used.has(path)) result.consumed++;
    else if (isIgnored(path)) result.ignored++;
    else result.problems.push(`IR field "${path}" is neither lifted nor in the ignored table (tools/lift/src/ignored.ts)`);
  }
  for (const file of files) {
    if (READ_FILES.some(r => r.test(file)) || IGNORED_FILES.some(([r]) => r.test(file))) continue;
    result.problems.push(`IR file "${file}" is neither read nor in IGNORED_FILES (tools/lift/src/ignored.ts)`);
  }
  return result;
}

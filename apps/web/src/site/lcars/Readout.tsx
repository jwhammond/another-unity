// SPDX-License-Identifier: GPL-3.0-or-later
export function Readout({ rows }: { rows: [string, string][] }) {
  return <dl class="lc-readout">{rows.map(([k, v]) => <div key={k}><dt>{k}</dt><dd>{v}</dd></div>)}</dl>;
}

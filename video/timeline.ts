// The shot list, in seconds. Scene numbers follow docs/launch-video/STORYBOARD.md.
export const T = {
  // 1: black hole opener
  holeEnd: 4.1,
  // 2: terminals (the problem)
  terminalsIn: 4.1,
  // 3: collapse into the sidebar
  appIn: 9.3,
  // 4: fleet, 5: inbox, 6: ship, 7: teammates
  fleet: 14.0,
  inbox: 20.0,
  ship: 26.0,
  teammates: 33.0,
  // 8: closer
  closerWipe: 39.0,
  end: 45,
};

/** Dither wipes through black: [start of cover, swap, end of reveal]. */
export const WIPES: [number, number, number][] = [
  [3.6, 4.1, 4.6],
  [8.8, 9.3, 9.9],
  [38.4, 39.0, 39.7],
];

export interface Caption {
  a: number;
  b: number;
  text: string;
}

export const CAPTIONS: Caption[] = [
  { a: 4.5, b: 9.0, text: "One terminal per agent doesn’t scale." },
  { a: 10.0, b: 13.9, text: "Orbit gives every task its own worktree, branch and agent." },
  { a: 14.3, b: 19.9, text: "Run Claude Code and Codex in parallel." },
  { a: 20.3, b: 25.9, text: "One inbox for everything that needs you." },
  { a: 26.3, b: 32.9, text: "From diff to merged PR, in one panel." },
  { a: 33.3, b: 38.4, text: "AI teammates that plan, build and review." },
];

export const REQUEST = "Add CSV export with tests";

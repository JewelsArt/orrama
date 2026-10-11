/**
 * Where each figure of Orr's set A stands in its cell (~/orrama-redesign/mockups/assets/orr/
 * sprites.json, the vector set Jules approved on 10–11 October). Every pose shares one cell, one
 * ground line and one scale, so any pose can replace any other in place; the avatars likewise.
 * heads: [x, y, hole] of the O's centre and the size of its hole, in sprite px.
 */
export interface SpriteSet {
  names: string[];
  cell: [number, number];
  ground: number;
  heads: Record<string, [number, number, number]>;
}

export const POSES: SpriteSet = {
  "names": [
    "hello",
    "wave",
    "point",
    "read",
    "think",
    "juggle",
    "telescope",
    "write",
    "carry",
    "search",
    "shrug",
    "mail",
    "sit",
    "doze",
    "jump",
    "peek"
  ],
  "cell": [
    500,
    416
  ],
  "ground": 332,
  "heads": {
    "hello": [
      252.897,
      124.061,
      51
    ],
    "wave": [
      273.942,
      148.068,
      47
    ],
    "point": [
      276.786,
      141.363,
      49
    ],
    "read": [
      247.343,
      140.568,
      50
    ],
    "think": [
      267.7,
      139.754,
      51
    ],
    "juggle": [
      249.871,
      153.78,
      45
    ],
    "telescope": [
      256.584,
      137.313,
      49
    ],
    "write": [
      269.518,
      150.24,
      51
    ],
    "carry": [
      264.963,
      166.871,
      41
    ],
    "search": [
      280.761,
      162.864,
      47
    ],
    "shrug": [
      253.867,
      137.149,
      51
    ],
    "mail": [
      245.319,
      129.441,
      50
    ],
    "sit": [
      256.288,
      155.258,
      46
    ],
    "doze": [
      259.207,
      191.67,
      47
    ],
    "jump": [
      270.606,
      143.822,
      44
    ],
    "peek": [
      252.633,
      275.93,
      65
    ]
  }
};

export const AVATARS: SpriteSet = {
  "names": [
    "orrpheus",
    "doctorr",
    "borris",
    "sorrel",
    "orriginal",
    "snorre",
    "victorr",
    "orra"
  ],
  "cell": [
    544,
    448
  ],
  "ground": 418,
  "heads": {
    "orrpheus": [
      258.712,
      156.584,
      60
    ],
    "doctorr": [
      257.469,
      160.569,
      61
    ],
    "borris": [
      244.84,
      161.487,
      63
    ],
    "sorrel": [
      281.296,
      149.631,
      63
    ],
    "orriginal": [
      289.326,
      174.055,
      62
    ],
    "snorre": [
      298.015,
      176.549,
      62
    ],
    "victorr": [
      278.593,
      140.711,
      62
    ],
    "orra": [
      239.608,
      168.644,
      62
    ]
  }
};

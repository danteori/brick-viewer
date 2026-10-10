// The game's default colour palette (2021): LINEAR 0-255 bytes, alpha 255. Values only; see
// palette.ts for the format and the linear -> sRGB conversion. Each group: its name, then 12
// colours as rrggbb hex.

export const DEFAULT_PALETTE_DESCRIPTION = 'The default palette.';

export const DEFAULT_PALETTE_GROUPS: readonly (readonly [string, string])[] = [
  ['Grayscale', 'ffffffb8b8b88888887272725a5a5a393939232323181818111111060606020202000000'],
  ['Plastic', '570509eb0606ff1d03f64906eb9d063da404098b050310ff0cf4ffa323553008480e0631'],
  ['Metallic', '291919604749b583862d2c1b726d41908b641b2d1c4172446490671e2729475c6083abb5'],
  ['Earthy', '1705025a10054d14014d1e07903c12a6683eff9f4eff794e32140d150c0333210dc2a33a'],
  ['Warm', '130201490401be1712be3b35ff959cff4f26ff2902ab361b6d4005ab6308ff920bffaf2f'],
  ['Nature', '16250143500c7a901e65ff510dcc2f004d000b360b051e03051205082b1b096035089242'],
  ['Cool', '050d110b1e2c01224000417a0876c80598ab5093a386faff5677f22537eb0c199c01042c'],
  ['Neon', '08001e1200393813648d2dffff5dfffd95ffff3a745b1237ff18ffff00377f001d370037'],
];

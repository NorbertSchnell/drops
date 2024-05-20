export default [
  { name: 'max-drops', min: 0, max: 24, step: 1, def: 6 },
  { name: 'division', min: 2, max: 12, step: 1, def: 3 },
  { name: 'period', min: 1, max: 12, step: 0.1, def: 7.5 },
  { name: 'attenuation', min: -20, max: 0, step: 1, def: -3 },
  { name: 'off-gain', min: -60, max: 0, step: 1, def: -20 },
  { name: 'gain', min: -40, max: 20, step: 1, def: 0 },
  { name: 'active', def: true },
  { name: 'clear' },
];

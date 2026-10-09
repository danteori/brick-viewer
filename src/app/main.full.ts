import '../ui/styles.css';
import { createApp } from './app.ts';
import { FEATURES } from './features.ts';
import { bloom } from '../render/bloom.ts';
import { setBloomPass } from '../render/matpass.ts';

setBloomPass(bloom);                 // the glow halo: full build only (lite skips bloom)

// Hosted at /, next to /legacy/save-viewer.html (the WebGL1 fallback).
createApp(document.getElementById('app'), { features: FEATURES, legacyHref: 'legacy/save-viewer.html' });

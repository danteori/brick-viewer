import '../ui/styles.css';
import '../ui/fonts.css';
import { createApp } from './app.ts';
import { FEATURES } from './features.ts';
import { bloom } from '../render/bloom.ts';
import { setBloomPass } from '../render/matpass.ts';
import { installFxPasses } from '../render/fx/frame.ts';
import * as shadows from '../render/fx/shadows.ts';
import * as ssao from '../render/fx/ssao.ts';

setBloomPass(bloom);                 // the glow halo: full build only (lite skips bloom)
installFxPasses(shadows, ssao);      // sun shadows and SSAO: full build only (lite has the sky, fog and water)

// Hosted at /, next to /legacy/save-viewer.html (the WebGL1 fallback).
createApp(document.getElementById('app'), { features: FEATURES, legacyHref: 'legacy/save-viewer.html' });

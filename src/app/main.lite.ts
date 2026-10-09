import '../ui/styles.css';
import { createApp } from './app.ts';
import { FEATURES } from './features.ts';

// Hosted at /lite/brick-viewer.html, next to /legacy/save-viewer.html (the WebGL1 fallback).
createApp(document.getElementById('app'), { features: FEATURES, legacyHref: '../legacy/save-viewer.html' });

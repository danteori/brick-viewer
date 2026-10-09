import '../ui/styles.css';
import { mountPlaceholder } from './placeholder.ts';

// Hosted at /lite/brick-viewer.html, next to /legacy/save-viewer.html.
mountPlaceholder(document.getElementById('app')!, '../legacy/save-viewer.html');

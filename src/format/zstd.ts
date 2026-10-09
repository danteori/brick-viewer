// zstd decoding through fzstd (MIT, ~8 KB), bundled in both builds so loading works offline.
// Encoding (wasm, full build only, lazy) arrives in Phase 4.
import { decompress } from 'fzstd';

export function zstdDecompress(bytes: Uint8Array): Uint8Array {
  return decompress(bytes);
}

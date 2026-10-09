// The page markup (the legacy viewer's body) and typed references to its elements.

const CHEV = '<svg class="chev" viewBox="0 0 10 10" aria-hidden="true"><path d="M3 1.5 6.5 5 3 8.5" fill="none" stroke="currentColor" stroke-width="1.6"/></svg>';

const MARKUP = `
<canvas id="c"></canvas>
<svg id="dims"></svg>
<svg id="ov"></svg>
<div id="hud"></div>
<div id="side">
  <div id="menu" aria-label="Brick size"><div class="mtitle">Brick size</div></div>
  <div id="mode" role="group" aria-label="Brick type">
    <button type="button" data-mode="brick" aria-pressed="true">Brick</button>
    <button type="button" data-mode="plain" aria-pressed="false" title="Plain Tile: flat top with the edge bevel, stud underside">Tile</button>
    <button type="button" data-mode="tile" aria-pressed="false" title="Smooth Tile: flat top, no top bevel, stud underside">Smooth Tile</button>
    <button type="button" data-mode="micro" aria-pressed="false">Microbrick</button>
  </div>
  <label id="lightbox">Lighting <select id="light" aria-label="Lighting preset"></select></label>
  <label id="undobox" title="How many edits Ctrl+Z can step back through">Undo steps <input id="undolim" type="number" min="1" max="500" step="1"></label>
  <div id="soundbox" role="group" aria-label="Sound">Sound
    <button type="button" id="mute" aria-pressed="false" title="Mute the editor sounds">On</button>
    <input id="vol" type="range" min="0" max="100" step="1" aria-label="Sound volume" title="Sound volume">
  </div>
  <div id="viewbox" role="group" aria-label="View">View
    <button type="button" id="underside" aria-pressed="false" title="Flip to the iso corner below the brick, or back above (U)">Underside (U)</button>
    <button type="button" id="xray" aria-pressed="false" title="X-ray: cut a round hole from the focused brick toward the camera (X)">X-ray (X)</button>
  </div>
  <div id="xraybox" hidden>
    <label title="Hole radius around the focused brick">Hole <input id="xraysize" type="range" min="0" max="100" step="1" aria-label="X-ray hole size"></label>
    <label title="How fast the hole widens toward the camera (cone half-angle)">Spread <input id="xrayspread" type="range" min="0" max="60" step="1" aria-label="X-ray cone spread, degrees"></label>
  </div>
  <div id="file">
    <button type="button" id="open">Open save (.brz)</button>
    <input type="file" id="pick" accept=".brz,.bp" hidden>
    <div id="status">drop or paste (Ctrl+V) a .brz</div>
    <div id="saverow"><button type="button" id="savebrz" title="Download the scene as a .brz (uncompressed), written into the save you opened">Save .brz</button></div>
  </div>
  <div id="pastemode" role="group" aria-label="What Ctrl+V does" title="What Ctrl+V does. Dropping a file or the Open button always opens a save.">Ctrl+V
    <button type="button" data-paste="upload" aria-pressed="true" title="Ctrl+V opens a .brz copied in the file manager">Upload</button>
    <button type="button" data-paste="brick" aria-pressed="false" title="Ctrl+V places the brick copied with Ctrl+C">Paste brick</button>
  </div>
  <section id="bricks" aria-label="Bricks catalogue">
    <button type="button" id="btoggle" aria-expanded="true" aria-controls="bgrid">Bricks
      ${CHEV}</button>
    <div id="bgrid"></div>
  </section>
</div>
<div id="name"></div>
<section id="props" aria-label="Brick properties">
  <button type="button" id="ptoggle" aria-expanded="true" aria-controls="pbody">Brick Properties
    ${CHEV}</button>
  <div id="pbody">
    <div class="prow"><span class="k">Name</span><span class="v" id="pname"></span></div>
    <div class="prow"><span class="k">Type</span><span class="v" id="ptype"></span></div>
    <div class="prow"><span class="k">Size</span><span class="v" id="psize"></span></div>
    <div class="prow"><span class="k">Orientation</span><span class="v" id="porient"></span></div>
    <div class="prow"><span class="k">Material</span><span class="v" id="pmat"></span></div>
    <button type="button" id="pcolor" class="prow" aria-expanded="false" aria-controls="ced"><span class="k">Color</span>
      <span class="v"><span id="cswatch"></span><span id="chexout"></span>
        ${CHEV}</span></button>
    <div id="ced" hidden>
      <div class="cw">
        <canvas id="cwheel" tabindex="0" role="slider" aria-label="Hue and saturation" aria-roledescription="colour wheel"
                aria-valuemin="0" aria-valuemax="360"></canvas>
        <div id="cmark"></div>
      </div>
      <label class="crow"><span>Brightness</span><input type="range" id="cval" min="0" max="1000" step="1" aria-label="Brightness"></label>
      <label class="crow"><span>Hex</span><input id="chex" type="text" maxlength="7" autocomplete="off" spellcheck="false" aria-label="Hex colour, #rgb or #rrggbb"></label>
    </div>
  </div>
  <button type="button" id="painttoggle" aria-expanded="false" aria-controls="paintbody" title="Colour palette, material and intensity: paint the focused brick">Paint
    ${CHEV}</button>
  <div id="paintbody" hidden></div>
</section>`;

/** Builds the page into document.body (the #app placeholder is replaced). */
export function mountDom(root: HTMLElement | null): void {
  const tpl = document.createElement('template');
  tpl.innerHTML = MARKUP;
  if (root && root !== document.body) root.replaceWith(tpl.content);
  else document.body.append(tpl.content);
}

export const $ = <T extends HTMLElement = HTMLElement>(id: string): T => document.getElementById(id) as T;
